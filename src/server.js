/* eslint no-console: 'off' */
/* eslint strict:0 */
/* eslint no-param-reassign: 'off' */

'use strict';

const spawn = require('child_process').spawn;
const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const uuid = require('uuid/v1');
const fs = require('fs-extra');
const rl = require('readline');
const compression = require('compression');
const WebSocketServer = require('websocket').server;
const config = require('./config.json');

const VG_PATH = config.vgPath;
const MOUNTED_DATA_PATH = config.dataPath;
const INTERNAL_DATA_PATH = config.internalDataPath;
const SERVER_PORT = config.serverPort || 3000;
const SERVER_BIND_ADDRESS = config.serverBindAddress || undefined;


var storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function(req, file, cb) {
    let ext = file.originalname.substring(
      file.originalname.lastIndexOf('.'),
      file.originalname.length
    );
    cb(null, Date.now() + ext);
  }
});
var limits = {
  files: 1, // allow only 1 file per request
  fileSize: 1024 * 1024 * 5 // 5 MB (max file size)
};
var upload = multer({ storage, limits });

const app = express();

// Configure global server settings
app.use(bodyParser.json()); // to support JSON-encoded bodies
app.use(
  bodyParser.urlencoded({
    // to support URL-encoded bodies
    extended: true
  })
);
app.use(compression());

// Serve the frontend
app.use(express.static('./build'));

// Make another Express object to keep all the API calls on a sensible path
// that can be proxied around if needed.
const api = express();
app.use('/api/v0', api);

// Open up CORS.
// TODO: can we avoid this?
// required for local usage with the Docker container (access docker container from outside)
api.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept'
  );
  next();
});

api.post('/xgFileSubmission', upload.single('xgFile'), (req, res) => {
  console.log('/xgFileSubmission');
  console.log(req.file);
  res.json({ path: req.file.path });
});

api.post('/gbwtFileSubmission', upload.single('gbwtFile'), (req, res) => {
  console.log('/gbwtFileSubmission');
  console.log(req.file);
  res.json({ path: req.file.path });
});

api.post('/gamFileSubmission', upload.single('gamFile'), (req, res) => {
  console.log('/gamFileSubmission');
  console.log(req.file);
  indexGamSorted(req, res);
});

function indexGamSorted(req, res) {
  const prefix = req.file.path.substring(0, req.file.path.lastIndexOf('.'));
  const sortedGamFile = fs.createWriteStream(prefix + '.sorted.gam', {
    encoding: 'binary'
  });
  const vgIndexChild = spawn(`${VG_PATH}vg`, [
    'gamsort',
    '-i',
    prefix + '.sorted.gam.gai',
    req.file.path
  ]);

  vgIndexChild.stderr.on('data', data => {
    console.log(`err data: ${data}`);
  });

  vgIndexChild.stdout.on('data', function(data) {
    sortedGamFile.write(data);
  });

  vgIndexChild.on('close', () => {
    sortedGamFile.end();
    res.json({ path: prefix + '.sorted.gam' });
  });
}

api.post('/getChunkedData', (req, res) => {
  let sentErrorResponse = false;
  console.time('request-duration');
  console.log('http POST getChunkedData received');
  console.log(`region = ${req.body.region}`);
  
  // Assign each request a UUID. v1 UUIDs can be very similar for similar
  // timestamps on the same node, but are still guaranteed to be unique within
  // a given nodejs process.
  req.uuid = uuid();

  // Make a temp directory for vg output files for this request
  req.tempDir = `./tmp-${req.uuid}`;
  fs.mkdirSync(req.tempDir);
  req.rmChunk = true;

  // We always have an XG file
  const xgFile = req.body.xgFile;

  // We sometimes have a GAM file with reads
  const gamFile = req.body.gamFile;
  req.withGam = true;
  if (!gamFile || gamFile === 'none') {
    req.withGam = false;
    console.log('no gam index provided.');
  }

  // We sometimes have a GBWT with haplotypes that override any in the XG
  const gbwtFile = req.body.gbwtFile;
  req.withGbwt = true;
  if (!gbwtFile || gbwtFile === 'none') {
    req.withGbwt = false;
    console.log('no gbwt file provided.');
  }

  // We sometimes have a BED file with regions to look at
  const bedFile = req.body.bedFile;
  req.withBed = true;
  if (!bedFile || bedFile === 'none') {
    req.withBed = false;
    console.log('no BED file provided.');
  }

  let dataPath = pickDataPath(req.body.dataPath);
  console.log(`dataPath = ${dataPath}`);

  // check that the path to the data is absolute and not pointing at something it shouldn't
  if (!isAllowedPath(dataPath)){
    req.error = "Data path not allowed (should be absolute and not pointing to /etc, /usr, etc...): " + dataPath;
    returnError(req, res);
    return;
  }
  
  // parse region
  // either a range -> seq:start-end
  // or a position and distance -> seq:post+distance
  let region = req.body.region;
  if (!(region.includes(':'))){
    req.error = "Wrong query: region doesn't contain a ':'. See ? button above.";
    returnError(req, res);
    return;
  }
  let region_col = region.split(":");
  let start_end = region_col[1].split("-");
  let pos_dist = region_col[1].split("+");
  let r_start = -1;
  let r_end = -1;
  let distance = -1;
  if(start_end.length == 2){
    r_start = Number(start_end[0]);
    r_end = Number(start_end[1]);
  } else if(pos_dist.length == 2){
    r_start = Number(pos_dist[0]);
    distance = Number(pos_dist[1]);
  } else {
    req.error = "Wrong query: coordinates must be in the form 'X:Y-Z' or 'X:Y+Y'. See ? button above.";
    returnError(req, res);
    return;
  }

  // check the bed file if this region has been pre-fetched
  let chunkPath = '';
  if(req.withBed){
    let i = 0;
    let nb_regions_in_bed = 0;
    if(req.body.regionInfo && Object.keys(req.body.regionInfo).length > 0){
      nb_regions_in_bed = req.body.regionInfo['desc'].length;
    }
    while (i < nb_regions_in_bed && chunkPath === ''){
      let region_chr = req.body.regionInfo['chr'][i];
      let region_start = req.body.regionInfo['start'][i];
      let region_end = req.body.regionInfo['end'][i];
      if(region_chr.concat(':', region_start, '-', region_end) === region){
	if(req.body.regionInfo['chunk'][i] !== ''){
	  chunkPath = req.body.regionInfo['chunk'][i]
	}
      }
      i += 1;
    }
    // check that the 'chunk.vg' file exists in the chunk folder
    chunkPath = `${dataPath}${chunkPath}`;
    if(chunkPath.endsWith('/')){
      chunkPath = chunkPath.substring(0, chunkPath.length-1);
    }
    let chunk_file = `${chunkPath}/chunk.vg`;
    if(fs.existsSync(chunk_file)){
      console.log(`found pre-fetched chunk at ${chunk_file}`);
      if(!isAllowedPath(chunk_file)){
	req.error = "Path to chunk not allowed (should be absolute and not pointing to /etc, /usr, etc...): " + chunk_file;
	returnError(req, res);
	return;
      }
    } else {
      console.log(`couldn't find pre-fetched chunk at ${chunk_file}`);
      chunkPath = '';
    }
  }
  
  if(chunkPath === ''){
    // call 'vg chunk' to generate graph
    let vgChunkParams = ['chunk', '-x', `${dataPath}${xgFile}`];
    // double-check that the file is a .xg and allowed
    if (!xgFile.endsWith('.xg')){
      req.error = "XG file doesn't end in .xg: " + xgFile;
      returnError(req, res);
      return;
    }
    if(!isAllowedPath(`${dataPath}${xgFile}`)){
      req.error = "File path not allowed (should be absolute and not pointing to /etc, /usr, etc...): " + `${dataPath}${xgFile}`;
      returnError(req, res);
      return;
    }
    if (req.withGam) {
      // Use a GAM index
      vgChunkParams.push('-a', `${dataPath}${gamFile}`, '-g');
      // double-check that the file is a .gam and allowed
      if (!gamFile.endsWith('.gam')){
	req.error = "GAM file doesn't end in .gam: " + gamFile;
	returnError(req, res);
	return;
      }
      if(!isAllowedPath(`${dataPath}${gamFile}`)){
	req.error = "File path not allowed (should be absolute and not pointing to /etc, /usr, etc...): " + `${dataPath}${gamFile}`;
	returnError(req, res);
	return;
      }
    }
    if (req.withGbwt) {
      // Use a GBWT haplotype database
      vgChunkParams.push('--gbwt-name', `${dataPath}${gbwtFile}`);
      // double-check that the file is a .gbwt and allowed
      if (!gbwtFile.endsWith('.gbwt')){
	req.error = "GBWT file doesn't end in .gbwt: " + gbwtFile;
	returnError(req, res);
	return;
      }
      if(!isAllowedPath(`${dataPath}${gbwtFile}`)){
	req.error = "File path not allowed (should be absolute and not pointing to /etc, /usr, etc...): " + `${dataPath}${gbwtFile}`;
	returnError(req, res);
	return;
      }
    }
    // to seach by node ID use "node" for the sequence name, e.g. 'node:1-10'
    if (region_col[0] === "node"){
      if(distance > -1){
	vgChunkParams.push('-r', r_start, '-c', distance);
      } else {
	vgChunkParams.push('-r', ''.concat(r_start, ":", r_end), '-c', 20);
      }
    } else {
      // reformat pos+dist into start-end range
      if(distance > -1){
	r_end = r_start + distance;
	region = region_col[0].concat(':', r_start, '-', r_end);
      }
      vgChunkParams.push(
	'-c',
	'20',
	'-p',
	`${region}`
      );
    }
    vgChunkParams.push(
      '-T',
      '-b',
      `${req.tempDir}/chunk`,
      '-E',
      `${req.tempDir}/regions.tsv`
    );

    console.log(`vg ${vgChunkParams.join(' ')}`);

    console.time('vg chunk');
    const vgChunkCall = spawn(`${VG_PATH}vg`, vgChunkParams);
    const vgViewCall = spawn(`${VG_PATH}vg`, ['view', '-j', '-']);
    let graphAsString = '';
    req.error = new Buffer(0);
    
    vgChunkCall.on('error', function(err) {
      console.log('Error executing ' + VG_PATH + 'vg ' + vgChunkParams.join(' ') + ': ' + err);
      if (!sentErrorResponse) {
	sentErrorResponse = true;
	returnError(req, res);
      }
      return;
    });

    vgChunkCall.stderr.on('data', data => {
      console.log(`vg chunk err data: ${data}`);
      req.error += data;
    });

    vgChunkCall.stdout.on('data', function(data) {
      vgViewCall.stdin.write(data);
    });

    vgChunkCall.on('close', code => {
      console.log(`vg chunk exited with code ${code}`);
      if (code != 0) {
        console.log('Error from ' + VG_PATH + 'vg ' + vgChunkParams.join(' '));
      }
      vgViewCall.stdin.end();
    });

    vgViewCall.on('error', function(err) {
      console.log('Error executing "vg view": ' + err);
      if (!sentErrorResponse) {
	sentErrorResponse = true;
	returnError(req, res);
      }
      return;
    });

    vgViewCall.stderr.on('data', data => {
      console.log(`vg view err data: ${data}`);
    });

    vgViewCall.stdout.on('data', function(data) {
      graphAsString += data.toString();
    });

    vgViewCall.on('close', code => {
      console.log(`vg view exited with code ${code}`);
      console.timeEnd('vg chunk');
      if (graphAsString === '') {
	if (!sentErrorResponse) {
          sentErrorResponse = true;
          returnError(req, res);
	}
	return;
      }
      req.graph = JSON.parse(graphAsString);
      req.region = [r_start, r_end];
      processAnnotationFile(req, res);
    });
  } else {
    // chunk has already been pre-fecthed and is saved in chunkPath
    req.tempDir = chunkPath;
    req.rmChunk = false;
    const vgViewCall = spawn(`${VG_PATH}vg`, ['view', '-j', `${req.tempDir}/chunk.vg`]);
    let graphAsString = '';
    req.error = new Buffer(0);
    vgViewCall.on('error', function(err) {
      console.log('Error executing "vg view": ' + err);
      if (!sentErrorResponse) {
	sentErrorResponse = true;
	returnError(req, res);
      }
      return;
    });

    vgViewCall.stderr.on('data', data => {
      console.log(`vg view err data: ${data}`);
    });

    vgViewCall.stdout.on('data', function(data) {
      graphAsString += data.toString();
    });

    vgViewCall.on('close', code => {
      console.log(`vg view exited with code ${code}`);
      if (graphAsString === '') {
	if (!sentErrorResponse) {
          sentErrorResponse = true;
          returnError(req, res);
	}
	return;
      }
      req.graph = JSON.parse(graphAsString);
      req.region = [r_start, r_end];
      processAnnotationFile(req, res);
    });
  }
});

function returnError(req, res) {
  console.log('returning error: ' + req.error);
  const result = {};
  result.error = req.error.toString('utf-8');
  res.json(result);
  // Clean up the temp directory for the request recursively
  if(req.tempDir){
    fs.remove(req.tempDir);
  }
}

function processAnnotationFile(req, res) {
  // find annotation file
  // TODO: This is not going to work if multiple people hit the server at once!
  // We need to make vg chunk take an argument from us for where to put the file.
  console.time('processing annotation file');
  fs.readdirSync(req.tempDir).forEach(file => {
    if (file.endsWith('annotate.txt')) {
      req.annotationFile = req.tempDir + '/' + file;
    }
  });

  if (
    !req.hasOwnProperty('annotationFile') ||
    typeof req.annotationFile === 'undefined'
  ) {
    returnError(req, res);
    return;
  }
  console.log(`annotationFile: ${req.annotationFile}`);

  // read annotation file
  const lineReader = rl.createInterface({
    input: fs.createReadStream(req.annotationFile)
  });

  let i = 0;
  lineReader.on('line', line => {
    const arr = line.replace(/\s+/g, ' ').split(' ');
    if (req.graph.path[i].name === arr[0]) {
      req.graph.path[i].freq = arr[1];
    } else {
      console.log('Mismatch');
    }
    i += 1;
  });

  lineReader.on('close', () => {
    console.timeEnd('processing annotation file');
    if (req.withGam === true) {
      processGamFile(req, res);
    } else {
      processRegionFile(req, res);
    }
  });
}

function processGamFile(req, res) {
  console.time('processing gam file');
  // Find gam file
  fs.readdirSync(req.tempDir).forEach(file => {
    if (file.endsWith('.gam')) {
      req.gamFile = req.tempDir + '/' + file;
    }
  });

  if(!isAllowedPath(req.gamFile)){
    req.error = "Path to GAM file not allowed (should be absolute and not pointing to /etc, /usr, etc...): " + req.gamFile;
    returnError(req, res);
    return;
  }
  
  // call 'vg view' to transform gam to json
  const vgViewChild = spawn(`${VG_PATH}vg`, ['view', '-j', '-a', req.gamFile]);

  vgViewChild.stderr.on('data', data => {
    console.log(`err data: ${data}`);
  });

  let gamJSON = '';
  vgViewChild.stdout.on('data', function(data) {
    gamJSON += data.toString();
  });

  vgViewChild.on('close', () => {
    req.gamArr = gamJSON
      .split('\n')
      .filter(function(a) {
        return a != '';
      })
      .map(function(a) {
        return JSON.parse(a);
      });
    console.timeEnd('processing gam file');
    processRegionFile(req, res);
  });
}

function processRegionFile(req, res) {
  console.time('processing region file');
  const regionFile = `${req.tempDir}/regions.tsv`;
  if(!isAllowedPath(regionFile)){
    req.error = "Path to region file not allowed (should be absolute and not pointing to /etc, /usr, etc...): " + regionFile;
    returnError(req, res);
    return;
  }

  const lineReader = rl.createInterface({
    input: fs.createReadStream(regionFile)
  });

  lineReader.on('line', line => {
    console.log('Region: ' + line);
    const arr = line.replace(/\s+/g, ' ').split(' ');
    req.graph.path.forEach(path => {
      if (path.name === arr[0]) path.indexOfFirstBase = arr[1];
    });
  });

  lineReader.on('close', () => {
    console.timeEnd('processing region file');
    cleanUpAndSendResult(req, res);
  });
}

function cleanUpAndSendResult(req, res) {
  if(req.rmChunk){
    fs.unlink(req.annotationFile);
    if (req.withGam === true) {
      fs.unlink(req.gamFile);
    }
    // Clean up the temp directory for the request recursively (even though it should be empty)
    fs.remove(req.tempDir);
  }

  const result = {};
  result.error = req.error.toString('utf-8');
  result.graph = req.graph;
  result.gam = req.withGam === true ? req.gamArr : [];
  result.region = req.region;
  res.json(result);
  console.timeEnd('request-duration');
}

// check that the path is absolute and not pointing at something it shouldn't
function isAllowedPath(inputPath) {
  let allowed_path = true;
  let forbidden_root = ['/etc', '/usr', '/sys'];
  for (var i = 0; i < forbidden_root.length; i++){
    if(inputPath.startsWith(forbidden_root[i])){
      allowed_path = false;
    }
  }
  if(inputPath.includes('..') || inputPath.includes('//')){
    allowed_path = false;
  }
  return(allowed_path);
}

// Decide where to pull the data from
// (builtin examples, mounted user data folder or uploaded data)
function pickDataPath(reqDataPath){
  let dataPath;
  switch (reqDataPath) {
    case 'mounted':
      dataPath = MOUNTED_DATA_PATH;
      break;
    case 'upload':
      dataPath = './';
      break;
    default:
      dataPath = INTERNAL_DATA_PATH;
  }
  if(!dataPath.endsWith('/')){
    dataPath = dataPath + '/';
  }
  return(dataPath);
}

api.get('/getFilenames', (req, res) => {
  console.log('received request for filenames');
  const result = {
    xgFiles: [],
    gbwtFiles: [],
    gamIndices: [],
    bedFiles: []
  };

  if(isAllowedPath(MOUNTED_DATA_PATH)){    
    // list files in folder
    fs.readdirSync(MOUNTED_DATA_PATH).forEach(file => {
      if (file.endsWith('.xg')) {
	result.xgFiles.push(file);
      }
      if (file.endsWith('.gbwt')) {
	result.gbwtFiles.push(file);
      }
      if (file.endsWith('.sorted.gam')) {
	result.gamIndices.push(file);
      }
      if (file.endsWith('.bed')) {
	result.bedFiles.push(file);
      }
    });
  } else {
    req.error = "Mounted data path not allowed (should be absolute and not pointing to /etc, /usr, etc...)" + MOUNTED_DATA_PATH;
    returnError(req, res);
    return;
  }

  console.log(result);
  res.json(result);
});

api.post('/getPathNames', (req, res) => {
  console.log('received request for pathNames');
  const result = {
    pathNames: []
  };

  let dataPath = pickDataPath(req.body.dataPath);

  // check that the path to the data is absolute and not pointing at something it shouldn't
  if (!result.error && !isAllowedPath(dataPath)){
    result.error = "Data path not allowed (should be absolute and not pointing to /etc, /usr, etc...): " + dataPath;
  }
  
  // call 'vg paths' to get path name information
  const xgFile = `${dataPath}${req.body.xgFile}`;

  if(!isAllowedPath(xgFile) && xgFile.endsWith(".xg")){
    req.error = "Path to XG file not allowed (should be absolute and not pointing to /etc, /usr, etc...): " + xgFile;
    returnError(req, res);
    return;
  }

  const vgViewChild = spawn(`${VG_PATH}vg`, ['paths', '-L', '-x', xgFile]);

  vgViewChild.stderr.on('data', data => {
    console.log(`err data: ${data}`);
  });

  let pathNames = '';
  vgViewChild.stdout.on('data', function(data) {
    pathNames += data.toString();
  });

  vgViewChild.on('close', () => {
    result.pathNames = pathNames.split('\n').filter(function(a) {
      // Eliminate empty names or underscore-prefixed internal names (like _alt paths) 
      return a != '' && !a.startsWith('_');
    }).sort();
    console.log(result);
    res.json(result);
  });
});

api.post('/getBedRegions', (req, res) => {
  console.log('received request for bedRegions');
  const result = {
    bedRegions: [],
    error: null
  };
  
  let bed_info = {chr:[], start:[], end:[], desc:[], chunk:[]};

  if(req.body.bedFile != 'none'){
    if(!isAllowedPath(req.body.bedFile) || !(req.body.bedFile.endsWith('.bed'))){
      result.error = "BED file path not allowed (should be absolute and not pointing to /etc, /usr, etc...): " + req.body.bedFile;
    }
    
    let dataPath = pickDataPath(req.body.dataPath);
    // check that the path to the data is absolute and not pointing at something it shouldn't
    if (!result.error && !isAllowedPath(dataPath)){
      result.error = "Data path not allowed (should be absolute and not pointing to /etc, /usr, etc...): " + dataPath;
    }
    
    const bedFile = `${dataPath}${req.body.bedFile}`;

    if(!fs.existsSync(bedFile)){
      result.error = "BED file not found: " + bedFile;
    }
    if(!result.error) {
      let bed_data = fs.readFileSync(bedFile).toString();
      let lines = bed_data.split('\n');
      lines.map(function(line){
	let records = line.split("\t");
	bed_info['chr'].push(records[0]);
	bed_info['start'].push(records[1]);
	bed_info['end'].push(records[2]);
	let desc = records.join('_');
	if (records.length > 3){
	  desc = records[3];
	}
	bed_info['desc'].push(desc);
	let chunk = '';
	if (records.length > 4){
	  chunk = records[4];
	}
	bed_info['chunk'].push(chunk); 
      });
    }
  }

  console.log('bed reading done');

  result.bedRegions = bed_info;
  res.json(result);
});

// Return the string URL for the host and port at which the given Express app
// server is listening, with HTTP scheme.
function getServerURL(server) {
  let address = server.address();
  return 'http://' + (address.family == 'IPv6' ? ('[' + address.address + ']') : address.address) + ':' + address.port;
}

// Start the server. Returns a promise that resolves when the server is ready.
// To stop the server, close() the result. Server base URL can be obtained with
// getUrl().
function start() {
  
  return new Promise((resolve, reject) => {
    
    // This holds the top-level state of the server and lets us close things up.
    // TODO: use a real class.
    let state = {
      // Express server
      server: undefined,
      // Web socket server
      wss: undefined,
      // Filesystem watch
      watcher: undefined,
      // Outstanding websocket connections
      connections: undefined,
      // Shut down the server
      close: async () => {
        // Close out all the servers
        state.wss.shutDown();
        state.server.close();
        state.watcher.close();
        
        // Wait for all the web sockets to be closed.
        await new Promise((resolve, reject) => {
          function stopIfReady() {
            if (state.connections.size == 0) {
              // No more open connections!
              resolve();
            } else {
              // Check back later
              setTimeout(stopIfReady, 10);
            }
          }
          stopIfReady();
        });
        
        console.log('TubeMapServer stopped.');
        // TODO: do we have to do more to wait for the close to take effect?
      },
      // Get the URL the server is listening on
      getUrl: () => {
        return getServerURL(state.server);
      },
      // Get the URL the server is listening on for the API
      getApiUrl: () => {
        return state.getUrl() + '/api/v0';
      }
    };

    // If the state fields are all filled in, resolve the promise for the closeable server object.
    function resolveIfReady() {
      if (state.server !== undefined &&
          state.wss !== undefined &&
          state.watcher !== undefined) {
        resolve(state);
      }
    }

    // Start the server on the selected port and save the HTTP server instance
    // created by app.listen for the WebScoketServer
    const server = app.listen(SERVER_PORT, SERVER_BIND_ADDRESS, () => {
      console.log('TubeMapServer listening on ' + getServerURL(server));
      // Server is ready so add to state.
      state.server = server;
      // See if the other server components are up yet and, if so, resolve our promise.
      resolveIfReady();
    });
    // Create the WebSocketServer, for watching for updated files, using the HTTP server instance
    // Note that all websocket connections on any path end up here!
    const wss = new WebSocketServer({ httpServer: server });

    // Set that holds all the WebSocketConnection instances that
    // notify the client of file directory changes
    state.connections = new Set();

    wss.on('request', function(request) {
      // We recieved a websocket connection request and we need to accept it.
      console.log(new Date() + ' Connection from origin ' + request.origin + '.');
      const connection = request.accept(null, request.origin);
      // We save the connection so that we can notify them when there is a change in the file system
      state.connections.add(connection);
      connection.on('close', function(reasonCode, description) {
        // When the websocket connection closes, we delete it from our set of open connections
        state.connections.delete(connection);
        console.log('A connection has been closed');
      });
    });

    // Web socket server is now ready
    state.wss = wss;

    // Start a watch. We can stop it by closing the watcher.
    const watcher = fs.watch(MOUNTED_DATA_PATH, function(event, filename) {
      // There was a change in the file directory
      console.log('Directory has been changed');
      for (let conn of state.connections) {
        // Notify all open connections about the change
        conn.send('change');
      }
    });

    // fs watcher is now ready
    state.watcher = watcher;

    // See if the server itself is up yet and, if so, resolve our promise.
    resolveIfReady();
  });
}

module.exports = {start};

if (require.main === module) {
  // We are running on the command line. Start the server.
  start();
}
