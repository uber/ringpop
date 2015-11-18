// Copyright (c) 2015 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
'use strict';

var DampReqRequest = require('../../request_response.js').DampReqRequest;
var EventEmitter = require('events').EventEmitter;
var events = require('./events.js');
var globalTimers = require('timers');
var LoggingLevels = require('../logging/levels.js');
var TypedError = require('error/typed');
var util = require('util');

var UnattainableRValError = TypedError({
    type: 'ringpop.damping.unattainable-rval',
    message: 'Unable to attain damp-req r-val',
    rVal: null,
    errors: null
});

function Damper(opts) {
    this.ringpop = opts.ringpop;
    this.timers = opts.timers || globalTimers;
    this.Date = opts.Date || Date;
    this.logger = this.ringpop.loggerFactory.getLogger('damping');

    // Flappers are members with damping potential. They have
    // exceeded the suppression limit and are considered as members
    // that may need damping. They are no longer considered flappy
    // when their damp score falls under the reuse limit.
    this.flappers = {}; // indexed by address (id)

    // TODO This is only temporary collection of damped members
    // since we're not actually damping them (marking the
    // member's status to damped) at this point. Damped members
    // are removed from this collection when the expiration timer
    // removes them.
    this.dampedMembers = {}; // indexed by address

    this.isDampTimerEnabled = false;
    // This damp timer runs only when there are flappy members
    // add to the flappers collection above.
    this.dampTimer = null;

    // The expiration timer runs only when there are damped members
    // in the dampedMembers collection above.
    this.expirationTimer = null;
}

util.inherits(Damper, EventEmitter);

function groupDampScoresByFlapper(allResponses) {
    var dampScoresByFlapper = {};

    for (var i = 0; i < allResponses.length; i++) {
        var dampReqResponse = allResponses[i];

        var responseScores = dampReqResponse.scores;
        if (!Array.isArray(responseScores)) continue;

        for (var j = 0; j < responseScores.length; j++) {
            var responseScore = responseScores[j];

            var member = responseScore.member;
            dampScoresByFlapper[member] = dampScoresByFlapper[member] || [];
            dampScoresByFlapper[member].push(responseScore);
        }
    }

    return dampScoresByFlapper;
}

function findFlappersToDamp(dampScoresByFlapper, rVal, suppressLimit) {
    // Evaluate the damp scores collected from the fan-out. For each flapper
    // find whether all scores exceed the suppress limit. If so, the flapper
    // should be damped.
    var membersToDamp = [];

    var flapperAddrs = Object.keys(dampScoresByFlapper);
    for (var i = 0; i < flapperAddrs.length; i++) {
        var flapperAddr = flapperAddrs[i];

        var flapperScores = dampScoresByFlapper[flapperAddr];
        if (flapperScores.length >= rVal &&
                haveAllScoresExceededLimit(flapperScores)) {
            membersToDamp.push(flapperAddr);
        }
    }

    return membersToDamp;

    function haveAllScoresExceededLimit(scores) {
        return scores.every(function each(score) {
            return score.dampScore >= suppressLimit;
        });
    }
}

// This function definition is pulled up and attached to the constructor
// so that its output can be easily unit tested.
Damper.getMembersToDamp = function getMembersToDamp(allResponses, rVal, config) {
    var dampScoresByFlapper = groupDampScoresByFlapper(allResponses);
    var suppressLimit = config.get('dampScoringSuppressLimit');
    return findFlappersToDamp(dampScoresByFlapper, rVal, suppressLimit);
};

Damper.prototype.addDampedMember = function addDampedMember(memberAddr) {
    this.dampedMembers[memberAddr] = {
        timestamp: this.Date.now()
    };
};

Damper.prototype.addFlapper = function addFlapper(flapper) {
    if (this.dampedMembers[flapper.address]) {
        this.logger.debug('ringpop damper already damped member', {
            local: this.ringpop.whoami()
        });
        return false;
    }

    if (this.flappers[flapper.address]) {
        this.logger.debug('ringpop damper already added flapper', {
            local: this.ringpop.whoami()
        });
        return false;
    }

    // TODO Limit number of flappers?
    // TODO Expire flappers?

    this.flappers[flapper.address] = flapper;
    this.logger.debug('ringpop damper added flapper', {
        local: this.ringpop.whoami(),
        flapper: flapper.address
    });
    this.ringpop.stat('increment', 'damper.flapper.added');
    this.ringpop.stat('gauge', 'damper.flappers',
        Object.keys(this.flappers).length);

    if (this._getFlapperCount() === 1) {
        this._startDampTimer();
    }

    return true;
};

Damper.prototype.dampMember = function dampMember(addr)  {
    var self = this;
    var member = this.ringpop.membership.findMemberByAddress(addr);

    if (!member) {
        this.logger.warn('ringpop damper cannot damp member; member does not exist', {
            local: this.ringpop.whoami(),
            member: addr
        });
        return false;
    }

    if (!this.hasFlapper(member)) {
        this.logger.warn('ringpop damper cannot damp member; member is not flappy', {
            local: this.ringpop.whoami(),
            member: addr
        });
        return false;
    }

    this.ringpop.membership.makeDamped(member.address);

    // Don't start anymore damping subprotocols for a member
    // that is already damped.
    this.removeFlapper(member.address);
    this.addDampedMember(member.address);

    if (!this.expirationTimer) {
        scheduleExpiration();
        this.logger.info('ringpop started damped member expiration timer', {
            local: this.ringpop.whoami()
        });
    }

    return true;

    function scheduleExpiration() {
        self.expirationTimer =
            self.timers.setTimeout(function onTimeout() {
                self.expireDampedMembers();
                scheduleExpiration();
        }, self.ringpop.config.get('dampedMemberExpirationInterval'));
    }
};

Damper.prototype.expireDampedMembers = function expireDampedMembers() {
    var undampedMembers = [];
    var suppressDuration = this.ringpop.config.get('dampScoringSuppressDuration');
    var keys = Object.keys(this.dampedMembers);
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var memberDamping = this.dampedMembers[key];
        var dampedDuration = this.Date.now() - memberDamping.timestamp;
        if (dampedDuration >= suppressDuration) {
            delete this.dampedMembers[key];
            undampedMembers.push({
                member: key,
                timeDamped: dampedDuration
            });
        }
    }

    if (undampedMembers.length === 0) {
        return undampedMembers;
    }

    this.emit('event', new events.DampedMemberExpirationEvent(undampedMembers));
    this.logger.info('ringpop damper undamped members', {
        local: this.ringpop.whoami(),
        suppressDuration: suppressDuration,
        undampedMembers: undampedMembers
    });

    // If there are no more damped members, stop trying to expire them.
    if (Object.keys(this.dampedMembers).length === 0) {
        this._stopExpirationTimer();
    }

    return undampedMembers;
};

Damper.prototype.destroy = function destroy() {
    this._stopDampTimer();
    this._stopExpirationTimer();
};

Damper.prototype.isDamped = function isDamped(flapper) {
    return !!this.dampedMembers[flapper.address];
};

Damper.prototype.hasFlapper = function hasFlapper(flapper) {
    return !!this.flappers[flapper.address];
};

Damper.prototype.hasStarted = function hasStarted() {
    return !!this.dampTimer;
};

Damper.prototype.initiateSubprotocol = function initiateSubprotocol(callback) {
    var self = this;
    var config = this.ringpop.config;

    // TODO Stop damp timer when cluster has reached damped limits
    if (!this._validateDampedClusterLimits()) {
        callback();
        return;
    }

    // You may think that a check to verify that flappers actually
    // exist before firing off the fanout is necessary. I know I did.
    // But in fact, the subprotocol will only ever be initiated when
    // there are known flappers. Otherwise the damp timer would never
    // have been scheduled.
    var flapperAddrs = this._getFlapperAddrs();
    this.logger.info('ringpop damper started', {
        local: this.ringpop.whoami(),
        flappers: flapperAddrs
    });
    this.emit('event', new events.DamperStartedEvent());

    // Select members to receive the damp-req.
    var nVal = config.get('dampReqNVal');
    var dampReqMembers = this.ringpop.membership.getRandomPingableMembers(
        nVal, flapperAddrs);
    var dampReqMemberAddrs = dampReqMembers.map(function map(member) {
        return member.address;
    });

    // Make sure rVal is satisfiable to begin with.
    var rVal = Math.min(config.get('dampReqRVal'), dampReqMembers.length);
    if (rVal === 0) {
        this.logger.warn('ringpop damper skipped subprotocol; there are not enough selectable damp req members', {
            local: this.ringpop.whoami(),
            flappers: flapperAddrs,
            rVal: rVal,
            nVal: nVal,
            numDampReqMembers: dampReqMembers.length
        });
        this.emit('event', new events.DampReqUnsatisfiedEvent());
        callback();
        return;
    }

    this._fanoutDampReqs(flapperAddrs, dampReqMembers, rVal, onDampReqs);

    function onDampReqs(err, res) {
        if (err) {
            self.ringpop.stat('increment', 'damper.damp-req.error');
            self.logger.warn('ringpop damper errored out', {
                local: self.ringpop.whoami(),
                dampReqMembers: dampReqMemberAddrs,
                errors: err
            });
            self.emit('event', new events.DampReqFailedEvent(err));
            callback();
            return;
        }

        // This log-level check is here to prevent stringification of responses
        // in cases where level is set above debug.
        if (self.logger.canLogAt(LoggingLevels.debug)) {
            self.logger.debug('ringpop damper received all damp-req responses', {
                local: self.ringpop.whoami(),
                flappers: flapperAddrs,
                responses: JSON.stringify(res)
            });
        }

        var membersToDamp = Damper.getMembersToDamp(res, rVal, config);
        if (membersToDamp.length === 0) {
            self.ringpop.stat('increment', 'damper.damp-req.inconclusive');
            self.logger.warn('ringpop damper inconclusive', {
                local: self.ringpop.whoami(),
                dampReqMembers: dampReqMemberAddrs,
                results: res
            });
            self.emit('event', new events.DampingInconclusiveEvent());
            callback();
            return;
        }

        for (var i = 0; i < membersToDamp.length; i++) {
            self.dampMember(membersToDamp[i]);
        }

        self.ringpop.stat('increment', 'damper.damp-req.damped');
        self.logger.warn('ringpop damped members', {
            local: self.ringpop.whoami(),
            dampReqMembers: dampReqMemberAddrs,
            membersToDamp: membersToDamp,
            results: res
        });
        self.emit('event', new events.DampedEvent());
        callback();
    }
};

Damper.prototype.removeFlapper = function removeFlapper(flapper) {
    var address = flapper.address || flapper;
    if (!this.flappers[address]) {
        this.logger.debug('ringpop flapper has not been added to the damper', {
            local: this.ringpop.whoami(),
            flapper: address
        });
        return false;
    }

    delete this.flappers[address];
    this.logger.debug('ringpop damper removed flapper', {
        local: this.ringpop.whoami(),
        flapper: address
    });
    this.ringpop.stat('increment', 'damper.flapper.removed');
    this.ringpop.stat('gauge', 'damper.flappers',
        Object.keys(this.flappers).length);

    if (this._getFlapperCount() === 0) {
        this._stopDampTimer();
    }

    return true;
};

Damper.prototype._fanoutDampReqs = function _fanoutDampReqs(flapperAddrs, dampReqMembers, rVal, callback) {
    var self = this;

    // Send out the damp-req to each member selected.
    var request = new DampReqRequest(this.ringpop, flapperAddrs);
    for (var i = 0; i < dampReqMembers.length; i++) {
        var dampReqAddr = dampReqMembers[i].address;
        this.ringpop.stat('increment', 'damp-req.send');
        this.ringpop.client.protocolDampReq(dampReqAddr, request,
            createDampReqHandler(dampReqAddr));
    }

    var numPendingReqs = dampReqMembers.length;
    var errors = [];
    var results = [];

    // Accumulate responses until rVal is satisfied or is impossible to satisfy because
    // too many error responses.
    function createDampReqHandler(addr) {
        return function onDampReq(err, res) {
            // Prevents double-callback
            if (typeof callback !== 'function') return;

            numPendingReqs--;

            if (err) {
                errors.push(err);
            } else {
                if (Array.isArray(res.changes)) {
                    self.ringpop.membership.update(res.changes);
                }

                // Enrich the result with the addr of the damp
                // req member for reporting purposes.
                res.dampReqAddr = addr;
                results.push(res);
            }

            // The first rVal requests will be reported.
            if (results.length >= rVal) {
                callback(null, results);
                callback = null;
                return;
            }

            if (numPendingReqs < rVal - results.length) {
                callback(UnattainableRValError({
                    flappers: flapperAddrs,
                    rVal: rVal,
                    errors: errors
                }));
                callback = null;
                return;
            }
        };
    }
};

Damper.prototype._getFlapperAddrs = function _getFlapperAddrs() {
    return Object.keys(this.flappers);
};

Damper.prototype._getFlapperCount = function _getFlapperCount() {
    return Object.keys(this.flappers).length;
};

Damper.prototype._startDampTimer = function _startDampTimer() {
    var self = this;

    if (this.isDampTimerEnabled) {
        this.logger.debug('ringpop damp timer already started', {
            local: this.ringpop.whoami()
        });
        return;
    }

    this.isDampTimerEnabled = true;
    schedule();
    this.logger.debug('ringpop damper started damp timer', {
        local: this.ringpop.whoami()
    });

    function schedule() {
        // TODO We may want to apply some backoff mechanism to the dampTimerInteval
        // in the event that a Ringpop cluster is significantly degraded. Fanning-out
        // damp-req requests may only make matters worse.
        self.dampTimer = self.timers.setTimeout(function onTimeout() {
            self.initiateSubprotocol(function onSubprotocol() {
                // It may be the case that the damp timer is stopped while in the
                // middle of a subprotocol. Make sure we don't schedule another
                // run if that happens.
                if (self.isDampTimerEnabled) schedule();
            });
        }, self.ringpop.config.get('dampTimerInterval'));
    }
};

Damper.prototype._stopDampTimer = function _stopDampTimer() {
    if (!this.isDampTimerEnabled) {
        this.logger.debug('ringpop damper already stopped damp timer', {
            local: this.ringpop.whoami()
        });
        return;
    }

    this.timers.clearTimeout(this.dampTimer);
    this.dampTimer = null;
    this.isDampTimerEnabled = false;
    this.logger.debug('ringpop damper stopped damp timer', {
        local: this.ringpop.whoami()
    });
};

Damper.prototype._stopExpirationTimer = function _stopExpirationTimer() {
    if (!this.expirationTimer) {
        this.logger.debug('ringpop damper expiration timer already stopped', {
            local: this.ringpop.whoami()
        });
        return;
    }

    this.timers.clearTimeout(this.expirationTimer);
    this.expirationTimer = null;
    this.logger.info('ringpop damper stopped expiration timer', {
        local: this.ringpop.whoami()
    });
};

Damper.prototype._validateDampedClusterLimits = function _validateDampedClusterLimits() {
    // Determine if the portion of damped members in the cluster exceeds
    // the maximum limit.
    var dampedMemberAddrs = Object.keys(this.dampedMembers);
    var dampedCount = dampedMemberAddrs.length;
    var dampedCurrent = dampedCount * 100 /
        this.ringpop.membership.getMemberCount();
    var dampedMax = this.ringpop.config.get('dampedMaxPercentage');
    if (dampedCurrent < dampedMax) {
        return true;
    }

    this.logger.warn('ringpop damper reached maximum allowable damped members', {
        local: this.ringpop.whoami(),
        dampedCurrent: dampedCurrent,
        dampedMax: dampedMax,
        dampedMembers: dampedMemberAddrs
    });
    this.emit('event', new events.DampedLimitExceededEvent());
    return false;
};

module.exports = Damper;