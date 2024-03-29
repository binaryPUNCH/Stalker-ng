'use strict';
/*jshint node:true*/

var util = require('util'),
	exec = require('child_process').exec,
	cheerio = require('cheerio'),
	http = require('http'),
	program = require('commander'),
	raven = require('raven'),
	baseUrl = "http://battlelog.battlefield.com",
	torPort = 9050;
GLOBAL.shouldExit = false;
GLOBAL.retries = 0;
GLOBAL.maxRetries = 3;

program
	.version('0.0.1')
	.option('-c, --client_name <name>', 'client name')
	.option('-h, --master_host <host>', 'master hostname')
	.option('-p, --master_path <path>', 'master path')
	.option('-P, --master_port <port>', 'master port')
	.option('-d, --debug', 'debug mode')
	.option('-v, --visual', 'shows visual process')
	.parse(process.argv);

if (!program.master_port)
	program.master_port = 80;

if (!program.master_host || !program.master_path) {
	console.log("You need to specify the host and path!");
	program.help();
}

if (!program.debug) {
	process.env.NODE_ENV = 'production';
	console.log("Setting up Sentry/Raven...");
	var client = new raven.Client('https://5fe4c20bdc5948ea9f9bb68f18060a12:9dec00111cfa49e5b61d16d322700a69@app.getsentry.com/7136');
	client.patchGlobal();
	console.log("Sentry/Raven set up!");
} else {
	console.log("Debug mode was set, Sentry/Raven will not be used.");
}

if (!program.client_name) {
	program.client_name = "Generic";
}

function getPlayer (playerName, playerAlias, playerPlatform, game, playerType, playerUrl, callback) {
	exec(util.format('curl --socks5-hostname 127.0.0.1:%s --connect-timeout 10 --compress -H "Accept-Encoding: gzip,deflate" %s/%s/user/%s', torPort, baseUrl, game, encodeURIComponent(playerName)),
		function (curlError, data, stderr) {
			var error = {key:"", value:""},
				gone = false,
				result = {
					/*name*/		n: 	playerName,
					/*platform*/	p: 	playerPlatform,
					/*type*/		t: 	playerType,
					/*url*/			u: 	playerUrl,
					/*status*/  	s: 	0 // 0 = No, 1 = Online, 2 = Playing
					/*serverUrl	su: "" */
					/*serverTitle st: ""*/
					/*alias		a:  playerAlias, */
				};

			if (playerAlias) {
				result.a = playerAlias;
			}

			if (data == "") {
				error.key = "Error while getting player";
				error.value = playerName;
			} else {
				var $ = cheerio.load(data);

				$(".xxlarge.playing").map(function() {
					result.s = 2; // Online
					result.su = "-";
					result.st = "Join Server";
				});

				$(".profile-view-status-info a").map(function(i, el) {
					// this === el
					result.su = baseUrl + $(this).attr("href"); // Url
					result.st = $(this).html().trim();			// Title
					result.s = 2;								// Playing
				});

				$(".xxlarge.online").map(function() {
					result.s = 1; // Online
				});

				$("div.base-middle-error").map(function(i, el) {
					gone = true; // Gone
				});

				if (gone) {
					error.key = "Player is gone";
					error.value = playerName;
					result.g=1;
				}

				if (curlError !== null && client) {
					client.captureError(new Error(e));
				}
			}

			if (error.key != "" && error.key !== "Player is gone") {
				if (program.debug || program.visual) {
					console.log("Error getting player: " + playerName + " retrying...");
				}
				GLOBAL.retries++;
				if (GLOBAL.retries <= GLOBAL.maxRetries) {
					getPlayer(playerName, playerAlias, playerPlatform, game, playerType, playerUrl, callback);
				} else {
					console.log("Fuck, lets bail!");
					if (client)
						client.captureMessage(error.key, {level: 'info', extra: {data: error.value}});
				}
			} else {
				GLOBAL.retries = 0;
				callback(error, result);
			}
		}
	);
}

function sendPlayer (data, callback) {

	var post_data = JSON.stringify(data);

	var post_options = {
		host: program.master_host,
		port: program.master_port,
		path: program.master_path,
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'Content-Length': post_data.length,
			'Client-Name': program.client_name
		}
	};

	var post_req = http.request(post_options, function(res) {
	res.setEncoding('utf8');
	res.on('data', function (chunk) {
			GLOBAL.retries = 0;
			callback(chunk);
		});
	});
	post_req.on('error', function (e) {
		GLOBAL.retries++;
		if (GLOBAL.retries <= GLOBAL.maxRetries) {
			sendPlayer(data, callback);
		} else {
			if (!program.debug && client)
				client.captureError(new Error('Error sending to the server'));
		}
	});

	// write parameters to post body
	post_req.write(post_data);
	post_req.end();
}

function findPlayer (callback) {
	var options = {
		host: program.master_host,
		port: program.master_port,
		path: program.master_path,
	};
	if (GLOBAL.shouldExit)
		return;

	http.get(options, function(res) {
		if (program.debug || res.statusCode != 200)
			console.log("Got response: " + res.statusCode);

		res.on("data", function(chunk) {
			callback(JSON.parse(chunk));
			GLOBAL.retries = 0;
		});
	}).on('error', function(e) {
		GLOBAL.retries++;
		if (GLOBAL.retries <= GLOBAL.maxRetries) {
			findPlayer(callback);
		} else {
			if (!program.debug && client)
				client.captureError(new Error('Error while receiving from the server'));
		}
	});
}

function loop () {
	if (program.debug)
		console.log("Finding a new player...");

	findPlayer(function (playerData) {
		if (program.debug) {
			console.log("Found player!");
			console.log("Querying Battlelog...");
		}

		getPlayer(playerData.name, playerData.alias, playerData.platform, playerData.game, playerData.type, playerData.url, function (error, result) {
			if (program.debug) {
				console.log(error, result);
				console.log("Got response from Battlelog!");
				console.log("PLAYER: " + playerData.name);
				console.log("Sending player...");
			}
			if (error.key != "") {
				if (client) 
					client.captureMessage(error.key, {level: 'info', extra: {data: error.value}});
			}
			if (program.visual) 
				console.log("PLAYER: " + playerData.name);

			sendPlayer(result, function (response) {
				if (program.debug) {
					console.log("Player sent!");
					console.log(response);
				}

				if (!GLOBAL.shouldExit)
					loop();
				else {
					process.exit();
					console.log("\nGracefully shutting down from SIGINT (Crtl-C)");
				}
			});
		});
	});
};

process.on( 'SIGINT', function() {
	console.log("Alright, let's shut down!");
	GLOBAL.shouldExit = true;
});

console.log("Server Slave started!");

	exec(util.format('curl --socks5-hostname 127.0.0.1:%s %s/api/test-client.php', torPort, program.master_host),
		function (curlError, data, stderr) {
			if (data == "OK") {
				loop();
			} else {
				if (client)
					client.captureError(new Error("Could not connect to server over Tor."));
				console.log("Could not connect to server over Tor.");
				process.exit();
			}
		}
	);
