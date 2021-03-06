const https = require('https');
const dns = require('dns');
const querystring = require('querystring');
const config = require('../config.json');
const kue = require('kue');
const queue = kue.createQueue({
    prefix: 'kue',
    redis: config.redis
});
const pg = require('../pg');
const pify = require('pify');

const regex_infoboard = new RegExp([
    /<div class='information-board(?:-sections)?'>/,
    /<div class='section'>/,
    /<span>(?:.+)<\/span>/,
    /<strong>([0-9, \.]+)<\/strong>/,
    /<span>(?:.+)<\/span>/,
    /<\/div>/,
    /<div class='section'>/,
    /<span>(?:.+)<\/span>/,
    /<strong>([0-9, \.]+)<\/strong>/,
    /<span>(?:.+)<\/span>/,
    /<\/div>/,
    /<div class='section'>/,
    /<span>(?:.+)<\/span>/,
    /<strong>([0-9, \.]+)<\/strong>/,
    /<span>(?:.+)<\/span>/,
    /<\/div>/,
    /<\/div>/,
    /(?:<div class='panel'>((?:.|\n)*?)<\/div>)?/
].map(r => r.source).join('\\n'));

module.exports = () => {
    const db_instances = DB.get('instances');

    db_instances.find({
        "blacklisted": {
            "$ne": true
        },
        "dead": {
            "$ne": true
        }
    }).then((instances) => {
        console.log(`[INSTANCES_UPDATE] Found ${instances.length} instances`);

        instances.forEach((instance) => {
            if(!instance.second) {
                instance.second = Math.floor(Math.random() * 60);

                db_instances.update({
                    _id: instance._id
                }, {
                    $set: {
                        second: instance.second
                    }
                });

                console.log(instance.name, instance.second);
            }

            if(!instance.second60) {
                instance.second60 = Math.floor(Math.random() * 3600);

                db_instances.update({
                    _id: instance._id
                }, {
                    $set: {
                        second60: instance.second60
                    }
                });

                console.log(instance.name, '60', instance.second60);
            }

            setTimeout(() => {
                console.log('Updating ' + instance.name);

                getHttpsRank(instance.name, (err, rank) => {
                    if (err) {
                        console.error(instance.name, 'CryptCheck failed: ' + err.message);

                        if (!instance.https_rank) {
                            console.error(instance.name, 'No cached HTTPS score. Cancelling update.');
                            return;
                        } else {
                            rank = {
                                rank: instance.https_rank,
                                score: instance.https_score
                            }
                        }
                    }

                    getObsRank(instance, (err, obs_rank) => {
                        if (err) {
                            console.error(instance.name, 'Obs failed: ' + err.message);

                            if (!instance.obs_rank) {
                                obs_rank = {
                                    rank: null,
                                    score: 0
                                };
                            } else {
                                obs_rank = {
                                    rank: instance.obs_rank,
                                    score: instance.obs_score
                                }
                            }
                        }

                        checkIpv6(instance.name, (is_ipv6) => {
                            getStats(instance.name, (err, stats) => {
                                if (err)
                                    return console.error(instance.name, 'GetStats failed: ' + err.message);

                                areRegistrationsOpened(instance.name, (openRegistrations) => {
                                    let _set = {
                                        https_rank: rank.rank,
                                        https_score: rank.score,
                                        ipv6: is_ipv6,
                                        users: stats.users,
                                        statuses: stats.statuses,
                                        connections: stats.connections,
                                        version: stats.version,
                                        version_score: stats.version_score,
                                        active_user_count: stats.active_user_count,
                                        first_user_created_at: stats.first_user_created_at,
                                        thumbnail: stats.thumbnail,
                                        openRegistrations,
                                        updatedAt: new Date()
                                    };

                                    if(obs_rank) {
                                        _set.obs_rank = obs_rank.rank;
                                        _set.obs_score = obs_rank.score;
                                        _set.obs_date = new Date();
                                    }

                                    db_instances.update({
                                        _id: instance._id
                                    }, {
                                        $set: _set
                                    }).then(async function() {
                                        let pgc = await pg.connect();

                                        try {
                                            let pg_instance = await pgc.query('SELECT id FROM instances WHERE name=$1', [instance.name]);

                                            if(pg_instance.rows.length === 0) {
                                                pg_instance = await pgc.query('INSERT INTO instances(name) VALUES($1) RETURNING id', [instance.name]);
                                            }

                                            console.log(`[INSTANCES_UPDATE/${instance.name}] Found matching pg ID ${pg_instance.rows[0].id}`);

                                            if(stats.clacks) {
                                                console.log(`[INSTANCES_UPDATE/${instance.name}] Saving X-Clacks-Overhead header`);

                                                await pgc.query('UPDATE instances SET clacks=$1 WHERE id=$2', [stats.clacks, pg_instance.rows[0].id]);
                                            }

                                            console.log(`[INSTANCES_UPDATE/${instance.name}] Creating history saving job`);

                                            let job = queue.create('save_instance_history', {
                                                title: instance.name,
                                                instance: pg_instance.rows[0].id
                                            }).ttl(60000);

                                            await pify(job.save.bind(job))();
                                        } catch(e) {
                                            throw e;
                                        } finally {
                                            await pgc.release();
                                        }
                                    }).catch((err) => {
                                        console.error(`[INSTANCES_UPDATE/${instance.name}]`, err);
                                    });
                                });
                            });
                        });
                    });
                });
            }, instance.second60 * 1000);
        });
    });
};

function haveStatsChanged(a, b) {
    for(let k of [
        'https_score',
        'ipv6',
        'users',
        'statuses',
        'connections',
        'version',
        'openRegistrations'
    ]) {
        if(a[k] !== b[k]) return true;
    }

    return false;
}

function getHttpsRank(name, cb) {
    https.get({
        hostname: 'tls.imirhil.fr',
        path: '/https/' + name + '.json',
        headers: {
            'User-Agent': USER_AGENT
        }
    }, (res) => {
        const statusCode = res.statusCode;
        const contentType = res.headers['content-type'];

        if (statusCode !== 200) {
            res.resume();
            return cb(new Error(`Status Code: ${statusCode}, expected 200`));
        }

        if (!/^application\/json/.test(contentType)) {
            res.resume();
            return cb(new Error(`Content type: ${contentType}, expected application/json`));
        }

        res.setEncoding('utf8');
        let rawData = '';
        res.on('data', (chunk) => rawData += chunk);
        res.on('end', () => {
            try {
                let data = JSON.parse(rawData);
                let grade = null;
                let score = 0;

                let n = 0;
                data.hosts.forEach((host) => {
                    if(host.grade) {
                        n++;

                        switch(host.grade.rank) {
                            case 'A+':
                                score += 100;
                                break;
                            case 'A':
                                score += 80;
                                break;
                            case 'B':
                                score += 60;
                                break;
                            case 'C':
                                score += 40;
                                break;
                            case 'D':
                                score += 20;
                                break;
                            case 'E':
                                score += 10;
                                break;
                            case 'F':
                                score += 5;
                                break;
                        }

                        if(!grade) {
                            grade = host.grade.rank;
                        } else if(grade !== host.grade.rank){
                            grade += ', ' + host.grade.rank;
                        }
                    }
                });

                score /= n;

                cb(null, {
                    score,
                    rank: grade
                });
            } catch(ex) {
                cb(ex);
            }
        });

        res.on('error', (e) => {
            cb(e);
        });
    }).on('error', (e) => {
        cb(e);
    });
}

function getObsRank(instance, cb) {
    let name = instance.name;

    if(instance.obs_date && new Date().getTime() - instance.obs_date.getTime() < 24 * 60 * 60 * 1000) {
        return cb(null, null);
    }

    Request.post('https://http-observatory.security.mozilla.org/api/v1/analyze?'+ querystring.stringify({
            host: name
        }), (err, res, raw) => {
        if(err) return cb(err);

        const statusCode = res.statusCode;
        if (statusCode !== 200) {
            res.resume();
            return cb(new Error(`Status Code: ${statusCode}, expected 200`));
        }

        const contentType = res.headers['content-type'];
        if (!/^application\/json/.test(contentType)) {
            res.resume();
            return cb(new Error(`Content type: ${contentType}, expected application/json`));
        }

        try {
            let data = JSON.parse(raw);

            if(data.state === 'FINISHED') {
                cb(null, {
                    rank: data.grade,
                    score: data.score
                });
            } else {
                cb(new Error('Test isn\'t finished'));
            }
        } catch(ex) {
            cb(ex);
        }
    });
}

function checkIpv6(name, cb) {
    dns.resolve6(name, (err, addr) => {
        cb(!err && addr.length > 0);
    });
}

function getStats(base_url, cb) {
    try {
        https.get({
            hostname: base_url,
            path: '/about/more',
            headers: {
                'User-Agent': USER_AGENT
            }
        }, (res) => {
            const statusCode = res.statusCode;
            const contentType = res.headers['content-type'];

            if (statusCode !== 200) {
                res.resume();
                return cb(new Error(`Status Code: ${statusCode}, expected 200`));
            }

            if (!/^text\/html/.test(contentType)) {
                res.resume();
                return cb(new Error(`Content type: ${contentType}, expected text/html`));
            }

            res.setEncoding('utf8');
            let rawData = '';
            res.on('data', (chunk) => rawData += chunk);
            res.on('end', () => {
                let res_infoboard = regex_infoboard.exec(rawData);

                if(res_infoboard && res_infoboard[1]) {
                    try {
                        let users = parseInt(res_infoboard[1].replace(/,| |\./g, ''));
                        let statuses = parseInt(res_infoboard[2].replace(/,| |\./g, ''));
                        let connections = parseInt(res_infoboard[3].replace(/,| |\./g, ''));
                        let info = res_infoboard[4];

                        if(!info)
                            info = '';

                        info = info.replace(/<br *\/?>/gi, '\n').replace(/<\/?(.+?)>/gi, '');

                        let clacks = res.headers['x-clacks-overhead'];

                        https.get({
                            hostname: base_url,
                            path: '/api/v1/instance',
                            headers: {
                                'User-Agent': USER_AGENT
                            }
                        }, (res) => {
                            const statusCode = res.statusCode;
                            const contentType = res.headers['content-type'];

                            if (statusCode !== 200) {
                                res.resume();
                                return cb(new Error(`Status Code: ${statusCode}, expected 200`));
                            }

                            if (!/^application\/json/.test(contentType)) {
                                res.resume();
                                return cb(new Error(`Content type: ${contentType}, expected application/json`));
                            }

                            res.setEncoding('utf8');
                            let rawData = '';
                            res.on('data', (chunk) => rawData += chunk);
                            res.on('end', () => {
                                try {
                                    let data = JSON.parse(rawData);

                                    let version = '<1.3';
                                    let version_score = 0;

                                    if(data.version)
                                        version = data.version;

                                    let version_norc = version.replace(/\.?rc[0-9]/, '');

                                    if(version === 'Mastodon::Version') {
                                        version = '1.3';
                                        version_score = 130;
                                    } else if(/^[0-9]\.[0-9](\.[0-9])?$/.test(version_norc)) {
                                        let version_a = version_norc.split('.').map((e) => {return parseInt(e);});

                                        version_score = (100 * version_a[0]) + (10 * version_a[1]) + (version_a.length === 3 ? version_a[2] : 0);
                                    } else {
                                        version = "";
                                    }

                                    let active_user_count = null;
                                    let first_user_created_at = null;

                                    if(data.stats) {
                                        active_user_count = data.stats.active_user_count;
                                        first_user_created_at = data.stats.first_user_created_at;
                                    }


                                    cb(null, {
                                        users,
                                        statuses,
                                        connections,
                                        info,
                                        version,
                                        version_score,
                                        active_user_count,
                                        first_user_created_at,
                                        thumbnail: data.thumbnail,
                                        clacks
                                    });
                                } catch(e) {
                                    return cb(e);
                                }
                            });

                            res.on('error', (e) => {
                                cb(e);
                            });
                        }).on('error', (e) => {
                            cb(e);
                        });
                    } catch(e) {
                        return cb(e);
                    }
                } else {
                    return cb(new Error('Could not parse infoboard.'));
                }
            });

            res.on('error', (e) => {
                cb(e);
            });
        }).on('error', (e) => {
            cb(e);
        });
    } catch(e) {
        cb(e);
    }
}

function areRegistrationsOpened(url, cb) {
    Request.get(`https://${url}/about`, (err, res, html) => {
        if(err) {
            console.error('areRegistrationsOpened', url, err);
            return cb(false);
        }

        const statusCode = res.statusCode;
        if (statusCode !== 200 || typeof html !== 'string') {
            console.error('areRegistrationsOpened', 'sc', url, statusCode, typeof html);
            res.resume();
            return cb(false);
        }

        cb(!/<div class='closed-registrations-message'>/.test(html));
    });
}
