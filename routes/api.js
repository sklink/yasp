var express = require('express');
var async = require('async');
var api = express.Router();
var constants = require('../constants');
var buildMatch = require('../buildMatch');
var buildPlayer = require('../buildPlayer');
var config = require('../config');
var request = require('request');
var rc_secret = config.RECAPTCHA_SECRET_KEY;
var multer = require('multer')(
{
    inMemory: true,
    fileSize: 100 * 1024 * 1024, // no larger than 100mb
});
var utility = require('../utility');
var queue = require('../queue');
var rQueue = queue.getQueue('request');
const crypto = require('crypto');
module.exports = function(db, redis)
{
    api.get('/items', function(req, res)
    {
        res.json(constants.items[req.query.name]);
    });
    api.get('/abilities', function(req, res)
    {
        res.json(constants.abilities[req.query.name]);
    });
    api.get('/match_pages', function(req, res)
    {
        res.json(constants.match_pages);
    });
    api.get('/player_pages', function(req, res)
    {
        res.json(constants.player_pages);
    });
    api.get('/navbar_pages', function(req, res)
    {
        res.json(constants.navbar_pages);
    });
    api.get('/matches/:match_id/:info?', function(req, res, cb)
    {
        buildMatch(
        {
            db: db,
            redis: redis,
            match_id: req.params.match_id
        }, function(err, match)
        {
            if (err)
            {
                return cb(err);
            }
            res.json(match);
        });
    });
    api.get('/players/:account_id/:info?/:subkey?', function(req, res, cb)
    {
        buildPlayer(
        {
            db: db,
            redis: redis,
            account_id: req.params.account_id,
            info: req.params.info,
            subkey: req.params.subkey,
            query: req.query
        }, function(err, player)
        {
            if (err)
            {
                return cb(err);
            }
            res.json(player);
        });
    });
    api.get('/user', function(req, res)
    {
        res.json(req.user);
    });
    api.get('/distributions');
    api.get('/picks/:n');
    api.get('/ratings/:account_id');
    api.get('/rankings/heroes/:hero_id');
    api.get('/rankings/players/:account_id');
    api.get('/faq');
    api.get('/status');
    //TODO will need to figure out how to do slugs if @albertcui insists on routing with them
    api.get('/blog/:n');
    //TODO @albertcui owns mmstats
    api.get('/mmstats');
    api.get('/banner');
    api.get('/cheese', function(req, res)
    {
        //TODO implement this
        res.json(
        {
            cheese: 1,
            goal: 2
        });
    });
    api.get('/search', function(req, res, cb)
    {
        db.raw(`
        SELECT account_id, personaname, avatarmedium, similarity(personaname, ?) 
        FROM players WHERE personaname ILIKE ? 
        ORDER BY similarity DESC LIMIT 1000
        `, [req.query.q, "%" + req.query.q + "%"]).asCallback(function(err, result)
        {
            if (err)
            {
                return cb(err);
            }
            res.json(result.rows);
        });
    });
    api.get('/health/:metric?', function(req, res, cb)
    {
        redis.hgetall('health', function(err, result)
        {
            if (err)
            {
                return cb(err);
            }
            for (var key in result)
            {
                result[key] = JSON.parse(result[key]);
            }
            if (!req.params.metric)
            {
                res.json(result);
            }
            else
            {
                var single = result[req.params.metric];
                res.status(single.metric < single.threshold ? 200 : 500).json(single);
            }
        });
    });
    api.post('/request_job', multer.single("replay_blob"), function(req, res, next)
    {
        request.post("https://www.google.com/recaptcha/api/siteverify",
        {
            form:
            {
                secret: rc_secret,
                response: req.body.response
            }
        }, function(err, resp, body)
        {
            if (err)
            {
                return next(err);
            }
            try
            {
                body = JSON.parse(body);
            }
            catch (err)
            {
                return res.render(
                {
                    error: err
                });
            }
            var match_id = Number(req.body.match_id);
            var match;
            if (!body.success && config.ENABLE_RECAPTCHA && !req.file)
            {
                console.log('failed recaptcha');
                return res.json(
                {
                    error: "Recaptcha Failed!"
                });
            }
            else if (req.file)
            {
                console.log(req.file);
                //var key = req.file.originalname + Date.now();
                //var key = Math.random().toString(16).slice(2);
                const hash = crypto.createHash('md5');
                hash.update(req.file.buffer);
                var key = hash.digest('hex');
                redis.setex(new Buffer('upload_blob:' + key), 60 * 60, req.file.buffer);
                match = {
                    replay_blob_key: key
                };
            }
            else if (match_id && !Number.isNaN(match_id))
            {
                match = {
                    match_id: match_id
                };
            }
            if (match)
            {
                console.log(match);
                queue.addToQueue(rQueue, match,
                {
                    attempts: 1
                }, function(err, job)
                {
                    res.json(
                    {
                        error: err,
                        job:
                        {
                            jobId: job.jobId,
                            data: job.data
                        }
                    });
                });
            }
            else
            {
                res.json(
                {
                    error: "Invalid input."
                });
            }
        });
    });
    api.get('/request_job', function(req, res, cb)
    {
        rQueue.getJob(req.query.id).then(function(job)
        {
            if (job)
            {
                job.getState().then(function(state)
                {
                    return res.json(
                    {
                        jobId: job.jobId,
                        data: job.data,
                        state: state,
                        progress: job.progress()
                    });
                }).catch(cb);
            }
            else
            {
                res.json(
                {
                    state: "failed"
                });
            }
        }).catch(cb);
    });
    return api;
};
