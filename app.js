#! /usr/local/bin/node

const commandLineArgs = require('command-line-args');
const fs = require('node:fs');
const path = require('node:path');
const _ = require('lodash');
const optionDefinitions = [
  { name: 'verbose', alias: 'v', type: Boolean },
  { name: 'in', type: String, defaultOption: true },
  { name: 'out', type: String, required: true },
  { name: 'overlap', alias: 'o', type: Number, defaultValue: 5 },
  { name: 'startPace', alias: 'p', type: Number, defaultValue: 300 },
  { name: 'paceIncrement', alias: 'i', type: Number, defaultValue: 100 },
  { name: 'paceDistance', alias: 'd', type: Number, defaultValue: 10 }, // in 0.1mm one-tenth
]

const options = commandLineArgs(optionDefinitions);

if (!options.in) {
  console.error('ERR: Source file param not found');
  process.exit();
}

if (!options.out) {
  options.out = outputFilename(options.in);
}

console.log('My options are', options);

options.paceDistance /= 10;

main(options)
  .then(({ shapeCounter }) => {
    process.stdout.write(`\n==Success: ${ shapeCounter } shapes processed ==\n`);
  })
  .catch(e => {
    console.error('===ERROR', e);
  })

async function main(options) {
  const stream = await fs.createReadStream(options.in);
  const outStream = await fs.createWriteStream(options.out);

  let shapeCounter = 0;
  let input = '';

  for await (const chunk of stream) {
    input += chunk;

    while (true) {
      //  const res = input.match(/^(.*?)(G0[XY\d.\s]+)(.*?G1[XY\d.\s]+(S[\d.]+)?F\d+)(.*?)(M5\sS0)(.*?)$/s);
      const res = input.match(/^(.*?)(G0[XY\d\-.\s]+)(.*?)(G1[XY\d\-.\s]+)(F(\d+))(.*?)(M5\s+S0)(.*?)$/s);
      if (!res) {
        debug('=======================================')
        break;
      }
      const [skip0, textBefore, textGoToStart, textPrepare, textFirstCmd, skip, cutPace, textCommands, textStop, textRest] = res;

      //  debug(textGoToStart, '+++', textPrepare, '+++', textCommands, '+++', textStop);
      process.stdout.write('.');

      shapeCounter++;
      let commands = _.compact(_.trim(textCommands).split(/[\n\r]+/));

      commands.unshift(_.trim(textFirstCmd));

      commands = removeSimilarCommands(commands);

      //------------ Ready to go
      const startingPoint = extractPoint(textGoToStart);
      const count = commands.length;
      let pp = extractPoint(commands[count - 1]);
      let outputText = textBefore + textGoToStart + textPrepare + '\n';

      if (!isShapeClosed(pp, startingPoint)) {
        commands = interpolateLaserPace(startingPoint, commands, cutPace);
        outputText += commands.join('\n') + '; overlap is skipped for non-closed shape\n' + textStop;
      } else {
        const overlapCommands = getOverlap(commands);

        commands = _.concat(commands, overlapCommands);
        commands = interpolateLaserPace(startingPoint, commands, cutPace);

        outputText += commands.join('\n') + '\n' + textStop;
      }

      outStream.write(outputText);
      input = textRest;
    }
  }

  outStream.write(input);

  return Promise.resolve({ shapeCounter });
}

function removeSimilarCommands(arr) {
  let lastCommand = '--';
  let i = 0;
  let count = arr.length;
  const ret = [];
  while (i < count) {
    if (arr[i] !== lastCommand) {
      lastCommand = arr[i];
      ret.push(lastCommand);
    }
    i++;
  }

  return ret;
}

function interpolateLaserPace(startingPoint, commands, fullPace) {
  let i = 0;
  let pace = options.startPace;
  let curPos = startingPoint;
  let paceDistance = 0;
  const createdCommands = [];

  while (i < commands.length && pace < fullPace) {
    let point = extractPoint(commands[i]);
    let newCommand;
    if (!point) {
      newCommand = commands[i];
      i++;
    } else {
      let dist;

      dist = distance(curPos, point);
      debug('**** dist ', dist);

      if (paceDistance + dist > options.paceDistance) {
        //  do {
        const fracture = (options.paceDistance - paceDistance) / dist;
        const cutPoint = interpolatePoint(curPos, point, fracture);
        pace = Math.min(pace + options.paceIncrement, fullPace);
        newCommand = lineToPoint(cutPoint) + ' F' + pace + ` ; fractured by ${ fracture.toFixed(4) }`;
        //createdCommands.push(newCommand);
        curPos = cutPoint;

        paceDistance = 0;
        //  dist = distance(curPos, point);
        debug('**** fracture ', fracture.toFixed(2));
        // } while (dist > 0 && pace < fullPace);
        //newCommand = lineToPoint(point) + ' F' + pace + ` ; rest of fractured line`;
      } else {
        paceDistance += dist;
        newCommand = lineToPoint(point) + ' F' + pace;
        curPos = point;
        dist = 0;
        i++;
        debug('**** full ', paceDistance, newCommand);
      }
    }
    createdCommands.push(newCommand);

  }

//  commands[0] = commands[0] + ' F' + pace
  return _.concat(createdCommands, commands.slice(i));
}

function outputFilename(inFileName) {
  const ext = path.extname(inFileName);
  const arr = [
    path.basename(inFileName, ext),
    'ovr' + options.overlap,
    'sp' + options.startPace,
    'pd' + options.paceDistance,
    'pi' + options.paceIncrement,
  ];
  return path.dirname(inFileName) + '/' + arr.join('-') + ext;
}

function isShapeClosed(pp, startingPoint) {
  return distance(pp, startingPoint) === 0;
}

function getOverlap(commands) {
  const overlapCommands = [];
  let overlapDistance = 0;
  let i = 1;
  let dist;
  let pp = extractPoint(commands[0]);
  let cp;

  overlapCommands.push(commands[0]);

  while (i < commands.length) {
    cp = extractPoint(commands[i]);

    dist = distance(pp, cp);
    overlapDistance += dist;

    if (overlapDistance < options.overlap) {
      overlapCommands.push(commands[i]);
      debug(`add in 1:${ commands[i] }`);
    } else {
      break;
    }

    pp = cp;
    i++;
  }

  if (commands.length > 2 && dist) {
    //-- last vector cut
    // debug(`-- ${ pp[0] },  ${ pp[1] }`);
    // debug(`FRACTURE: fracture = 1 - (${overlapDistance } - ${ options.overlap }) / ${ dist }`);

    const fracture = Math.min(1, 1 - (overlapDistance - options.overlap) / dist);
    const point = interpolatePoint(pp, cp, fracture);
    debug(`Interpolated POINT: ${ point[0] }, ${ point[1] }`);

    const add = lineToPoint(point) + ` ; Interpolated as ${ fracture.toFixed(2) } of last line (${ pp[0] } x ${ pp[1] } --> ${ cp[0] } x ${ cp[1] })`;
    overlapCommands.push(add);
    debug(`add in 2: add`);
  }

  debug(`--pp_added ${ overlapCommands.length } commands\n${ overlapCommands.join('\n') }`);

  const overlapCount = overlapCommands.length;
  overlapCommands.unshift(` ; Added ${ overlapCount } commands`);

  return overlapCommands;
}

function extractPoint(cmd) {
  //debug('Extract from', cmd)
  const res = _.trim(cmd).match(/X([\d.\-]+)\s+Y([\d.\-]+)/);

  if (!res) {
    //  console.error("!! Cannot extract point from", cmd);
    return null;
  }
  return [parseFloat(res[1]), parseFloat(res[2])];
}

function distance(p1, p2) {
  return Math.sqrt((p2[0] - p1[0]) * (p2[0] - p1[0]) + (p2[1] - p1[1]) * (p2[1] - p1[1]));
}

function interpolatePoint(p1, p2, fracture) {
  // debug(`POINT CALC: ${ p1[0] } + (${ p2[0] } - ${ p1[0] }) * ${ fracture }, ${ p1[1] } + (${ p2[1] } - ${ p1[1] }) * ${ fracture }`);
  return [p1[0] + (p2[0] - p1[0]) * fracture, p1[1] + (p2[1] - p1[1]) * fracture];
}

function lineToPoint(p) {
  return `G1 X${ p[0].toFixed(2) } Y${ p[1].toFixed(2) }`;
}

function debug() {
  if (options.verbose) {
    console.log('===', ...arguments);
  }
}

