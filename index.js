global._mckay_statistics_opt_out = true; // Opt out of node-steam-user stats

const optionDefinitions = [
    { name: 'config', alias: 'c', type: String, defaultValue: './config.js' }, // Config file location
    { name: 'steam_data', alias: 's', type: String } // Steam data directory
];

const winston = require('winston'),
    args = require('command-line-args')(optionDefinitions, { partial: true }),
    bodyParser = require('body-parser'),
    rateLimit = require('express-rate-limit'),
    utils = require('./lib/utils'),
    queue = new (require('./lib/queue'))(),
    InspectURL = require('./lib/inspect_url'),
    botController = new (require('./lib/bot_controller'))(),
    CONFIG = require(args.config),
    redis = new (require('./lib/redis'))(CONFIG.redis_url),
    postgres = new (require('./lib/postgres'))(CONFIG.database_url, CONFIG.enable_bulk_inserts),
    gameData = new (require('./lib/game_data'))(CONFIG.game_files_update_interval, CONFIG.enable_game_file_updates),
    errors = require('./errors'),
    Job = require('./lib/job'),
    zlib = require('zlib'),
    fs = require('fs'),
    cron = require('cron').CronJob,
    os = require('os');
const nodeCluster = require('cluster');

const startTime = new Date();

const currencies = {
    "1": "USD",
    "2": "GBP",
    "3": "EUR",
    "4": "CHF",
    "5": "RUB",
    "6": "PLN",
    "7": "BRL",
    "8": "JPY",
    "9": "NOK",
    "10": "IDR",
    "11": "MYR",
    "12": "PHP",
    "13": "SGD",
    "14": "THB",
    "15": "VND",
    "16": "KRW",
    "17": "TRY",
    "18": "UAH",
    "19": "MXN",
    "20": "CAD",
    "21": "AUD",
    "22": "NZD",
    "23": "CNY",
    "24": "INR",
    "25": "CLP",
    "26": "PEN",
    "27": "COP",
    "28": "ZAR",
    "29": "HKD",
    "30": "TWD",
    "31": "SAR",
    "32": "AED",
    "34": "ARS",
    "35": "ILS",
    "36": "BYN",
    "37": "KZT",
    "38": "KWD",
    "39": "QAR",
    "40": "CRC",
    "41": "UYU",
};

let rates = {};

loadRates();

if (process.env.NODE_APP_INSTANCE === '1') {
    new cron(
        '* * * * * *',
        async () => {
            const requests = await redis.get('requests');
            redis.set('requests', 0);

            const bots_online = await redis.get('bots_online');
            redis.set('bots_online', 0);
            redis.set('bots_online_last', bots_online);

            const bots_total = await redis.get('bots_total');
            redis.set('bots_total', 0);
            redis.set('bots_total_last', bots_total);

            const queue_size = await redis.get('queue_size');
            redis.set('queue_size', 0);
            redis.set('queue_size_last', queue_size);

            const queue_concurrency = await redis.get('queue_concurrency');
            redis.set('queue_concurrency', 0);
            redis.set('queue_concurrency_last', queue_concurrency);

            let requests_last = await redis.get('rqs_last');

            if (!requests_last) {
                requests_last = [];
            } else {
                requests_last = JSON.parse(requests_last);

                requests_last.reverse();

                requests_last.push(requests);

                requests_last.reverse();

                if (requests_last.length > 50) {
                    requests_last.length = 50;
                }
            }

            redis.set('rqs_last', JSON.stringify(requests_last));
        },
        null,
        true
    );

}
new cron(
    '* * * * * *',
    async () => {
        setTimeout(() => {
            redis.incrBy('bots_online', parseInt(botController.getReadyAmount()));
            redis.incrBy('bots_total', parseInt(botController.bots.length));
            redis.incrBy('queue_size', parseInt(queue.queue.length));
            redis.incrBy('queue_concurrency', parseInt(queue.concurrency));
        }, 200);
    },
    null,
    true
);

new cron(
    '0 * * * * *',
    async () => {
        await loadRates();
    },
    null,
    true
);

async function loadRates() {
    const compressed = await redis.get('meta:currencies:v2');
    if (compressed) {
        let data = zlib
            .inflateSync(Buffer.from(compressed, 'base64'))
            .toString();
        rates = JSON.parse(data);
    }
}
if (nodeCluster.isMaster) {

    (async () => {
        console.log(`Primary ${process.pid} is running`);

        // Fork workers.
        for (let i = 1; i < CONFIG.cluster_count + 1; i++) {
            nodeCluster.fork({
                clusterId: i
            });

            nodeCluster.on('exit', (worker, code, signal) => {
                console.log('worker %d died (%s). restarting...', worker.process.pid, signal || code);
                nodeCluster.fork({
                    clusterId: i
                });
            });
        }
    })();



} else {

    setInterval(() => {
        if (
            (new Date().getTime() - startTime.getTime()) / 1000 > 300 &&
            botController.getReadyAmount() < (CONFIG.bots_count / CONFIG.cluster_count * 0.1)
        ) {
            process.exit();
        }
    }, 1000);


    if (CONFIG.max_simultaneous_requests === undefined) {
        CONFIG.max_simultaneous_requests = 1;
    }
    winston.level = CONFIG.logLevel || 'debug';

    if (args.steam_data) {
        CONFIG.bot_settings.steam_user.dataDirectory = args.steam_data;
    }

    setTimeout(() => {

        fs.readFile('accounts.txt', 'utf8', async (err, data) => {
            if (err) {
                console.error(err);
                return;
            }

            const perCluster = CONFIG.bots_count / CONFIG.cluster_count;
            const clusterMax = perCluster * ((process.env.NODE_APP_INSTANCE * 1) + 1);

            const lines = data.split('\n').slice(clusterMax - perCluster, clusterMax);

            /*
            console.log('---------------------------');
            console.table({
                instanceId: process.env.NODE_APP_INSTANCE,
                linesLength: lines.length,
                clusterMax,
                perCluster,
                clusterCount,
                botsCount,
            });
            console.log('---------------------------');
            */

            for await (const [index, line] of lines.entries()) {
                const [user, pass, email, ep] = line.split(':');
                const settings = Object.assign({}, CONFIG.bot_settings);

                botController.addBot({ user, pass, session: Math.round(index / 5) }, settings);

                await sleep(1000);

            }
        });
    }, process.env.NODE_APP_INSTANCE * 2000);

    setTimeout(() => {
        process.exit(1);
    }, CONFIG.cluster_life * 60 * 60 * 1000 + (parseInt(process.env.NODE_APP_INSTANCE) * 15 * 60 * 1000)); // delay the clusters 15mins

    /*
    for (let [i, loginData] of CONFIG.logins.entries()) {
        const settings = Object.assign({}, CONFIG.bot_settings);
    
        botController.addBot(loginData, settings);
    }
    */

    postgres.connect();

    // Setup and configure express
    const app = require('express')();
    app.use(function (req, res, next) {
        if (req.method === 'POST') {
            // Default content-type
            req.headers['content-type'] = 'application/json';
        }
        next();
    });
    app.use(bodyParser.json({ limit: '5mb' }));

    app.use(function (error, req, res, next) {
        // Handle bodyParser errors
        if (error instanceof SyntaxError) {
            errors.BadBody.respond(res);
        }
        else next();
    });


    if (CONFIG.trust_proxy === true) {
        app.enable('trust proxy');
    }

    CONFIG.allowed_regex_origins = CONFIG.allowed_regex_origins || [];
    CONFIG.allowed_origins = CONFIG.allowed_origins || [];
    const allowedRegexOrigins = CONFIG.allowed_regex_origins.map((origin) => new RegExp(origin));

    app.use(function (req, res, next) {
        if (CONFIG.allowed_origins.length > 0 && req.get('origin') != undefined) {
            // check to see if its a valid domain
            const allowed = CONFIG.allowed_origins.indexOf(req.get('origin')) > -1 ||
                allowedRegexOrigins.findIndex((reg) => reg.test(req.get('origin'))) > -1;

            if (allowed) {
                res.header('Access-Control-Allow-Origin', req.get('origin'));
                res.header('Access-Control-Allow-Methods', 'GET');
            }
        }
        next()
    });

    if (CONFIG.rate_limit && CONFIG.rate_limit.enable) {
        app.use(rateLimit({
            windowMs: CONFIG.rate_limit.window_ms,
            max: CONFIG.rate_limit.max,
            headers: false,
            handler: function (req, res) {
                errors.RateLimit.respond(res);
            }
        }))
    }

    app.get('/float', processRequest);
    app.post('/float', processRequest);
    app.get('/', processRequest);

    app.post('/bulk', (req, res) => {
        if (!req.body || (CONFIG.bulk_key && req.body.bulk_key != CONFIG.bulk_key)) {
            return errors.BadSecret.respond(res);
        }

        if (!req.body.links || req.body.links.length === 0) {
            return errors.BadBody.respond(res);
        }

        if (CONFIG.max_simultaneous_requests > 0 && req.body.links.length > CONFIG.max_simultaneous_requests) {
            return errors.MaxRequests.respond(res);
        }

        const job = new Job(req, res, /* bulk */ true);

        for (const data of req.body.links) {
            const link = new InspectURL(data.link);
            if (!link.valid) {
                return errors.InvalidInspect.respond(res);
            }

            let price;

            if (canSubmitPrice(req.body.priceKey, link, data.price)) {
                price = parseInt(data.price);
            }

            winston.info(link);

            job.add(link, price);
        }

        try {
            handleJob(job);
        } catch (e) {
            winston.debug(e);
            errors.GenericBad.respond(res);
        }
    });

    app.get('/stats', async (req, res) => {
        const requests_last = JSON.parse(await redis.get('rqs_last')).map(n => parseInt(n));

        const sum = requests_last.reduce((a, b) => a + b, 0);
        const avg = (sum / requests_last.length) || 0;

        res.json({
            bots_online: await redis.get('bots_online_last'),
            bots_total: await redis.get('bots_total_last'),
            queue_size: await redis.get('queue_size_last'),
            queue_concurrency: await redis.get('queue_concurrency_last'),
            requests: requests_last,
            avgTPS: avg,
            cluster_id: process.env.NODE_APP_INSTANCE,
        });
    });

    const http_server = require('http').Server(app);
    http_server.listen(CONFIG.http.port);
    winston.info('Listening for HTTP on port: ' + CONFIG.http.port);


    queue.process(CONFIG.bots_count / CONFIG.cluster_count, botController, async (job) => {
        const itemData = await botController.lookupFloat(job.data.link);
        winston.debug(`Received itemData for ${job.data.link.getParams().a}`);

        // Save and remove the delay attribute
        let delay = itemData.delay;
        delete itemData.delay;

        // add the item info to the DB
        await postgres.insertItemData(itemData.iteminfo, job.data.price);

        // Get rank, annotate with game files
        itemData.iteminfo = Object.assign(itemData.iteminfo, await postgres.getItemRank(itemData.iteminfo.a));
        gameData.addAdditionalItemProperties(itemData.iteminfo);

        itemData.iteminfo = utils.removeNullValues(itemData.iteminfo);
        itemData.iteminfo.stickers = itemData.iteminfo.stickers.map((s) => utils.removeNullValues(s));

        job.data.job.setResponse(job.data.link.getParams().a, itemData.iteminfo);

        return delay;
    });

    queue.on('job failed', (job, err) => {
        const params = job.data.link.getParams();
        winston.debug(`Job Failed! S: ${params.s} A: ${params.a} D: ${params.d} M: ${params.m} IP: ${job.ip}, Err: ${(err || '').toString()}`);

        job.data.job.setResponse(params.a, errors.TTLExceeded);
    });
}

process.on('uncaughtException', err => {
    // console.log(`Uncaught Exception: ${err.message}`)
    // process.exit(1)
})
process.on('unhandledRejection', (reason, promise) => {
    // console.log('Unhandled rejection at ', promise, `reason: ${reason.message}`)
    // process.exit(1)
})


function sleep(millis) {
    return new Promise((resolve) => setTimeout(resolve, millis));
}

async function handleJob(job) {

    // See which items have already been cached
    const itemData = await postgres.getItemData(job.getRemainingLinks().map(e => e.link));
    for (let item of itemData) {
        const link = job.getLink(item.a);

        if (!item.price && link.price) {
            postgres.updateItemPrice(item.a, link.price);
        }

        gameData.addAdditionalItemProperties(item);
        item = utils.removeNullValues(item);

        job.setResponse(item.a, item);
    }

    if (!botController.hasBotOnline()) {
        return job.setResponseRemaining(errors.SteamOffline);
    }

    if (CONFIG.max_simultaneous_requests > 0 &&
        (queue.getUserQueuedAmt(job.ip) + job.remainingSize()) > CONFIG.max_simultaneous_requests) {
        return job.setResponseRemaining(errors.MaxRequests);
    }

    if (CONFIG.max_queue_size > 0 && (queue.size() + job.remainingSize()) > CONFIG.max_queue_size) {
        return job.setResponseRemaining(errors.MaxQueueSize);
    }

    if (job.remainingSize() > 0) {
        queue.addJob(job, CONFIG.bot_settings.max_attempts);
    }
}

function canSubmitPrice(key, link, price) {
    return price && link.isMarketLink() && utils.isOnlyDigits(price); // CONFIG.price_key && key === CONFIG.price_key &&
}

function processRequest(req, res) {

    redis.incr('requests');

    // Get and parse parameters
    let link;

    if ('url' in req.query) {
        link = new InspectURL(req.query.url);
    } else if ('url' in req.body) {
        link = new InspectURL(req.body.url);
    } else if ('a' in req.query && 'd' in req.query && ('s' in req.query || 'm' in req.query)) {
        link = new InspectURL(req.query);
    }

    if (!link || !link.getParams()) {
        return errors.InvalidInspect.respond(res);
    }

    const job = new Job(req, res, /* bulk */ false);

    let price;

    if (canSubmitPrice(null, link, req.query?.price || req.body?.price)) {


        price = parseInt(req.query?.price || req.body?.price) || null;
        const currency = req.query?.currency;
        if (currency) {
            price = Math.round(price / rates[currencies[parseInt(currency) - 2000]]);
        }
    }

    job.add(link, price);

    try {
        handleJob(job);
    } catch (e) {
        winston.debug(e);
        errors.GenericBad.respond(res);
    }
}
