#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const currentDir = process.cwd();
const photosDir = path.resolve(currentDir, 'Google Photos');
const tmpMergeDir = path.resolve(currentDir, 'Temporary Merged Takeout');
const tmpPhotosDir = path.resolve(tmpMergeDir, 'Takeout/Google Photos');

function formatDate(date, options = {}) {
  return new Intl.DateTimeFormat('en-US', options).format(date);
}

function readFilesRecursively(directory) {
  if(!fs.existsSync(directory)) return [];
  const dirents = fs.readdirSync(directory, { withFileTypes: true });
  return dirents.flatMap((dirent)=> {
    const direntPath = path.resolve(directory, dirent.name);
    return dirent.isDirectory() ? readFilesRecursively(direntPath) : direntPath;
  });
}

function checkTools() {
  const rsyncInfo = execSync(`rsync --version`, { encoding: 'utf-8' });
  if(!rsyncInfo.startsWith('rsync  version 3')) {
    console.log('Install `rsync` version 3 or later to continue.');
    process.exit(1);
  }

  try {
    execSync(`which SetFile`);
  } catch {
    console.log('Install `SetFile` to continue.');
    process.exit(1);
  }

  try {
    execSync(`which 7z`);
  } catch {
    console.log('Install `p7zip` to continue.');
    process.exit(1);
  }
}

function createPhotosDir() {
  if(fs.existsSync(photosDir)) return;
  fs.mkdirSync(photosDir);
}

function extractTakeouts() {
  const files = fs.readdirSync(currentDir);
  const zips = files.filter(f=> f.startsWith('takeout') && f.endsWith('.zip'));
  if(!zips.length) return console.log('There are no Google Takeout zip files.');

  zips.forEach((file)=> {
    const filePath = path.resolve(currentDir, file);
    const extractDir = filePath.replace(/\.zip$/, '');
    console.log(`Extracting ${file} to ${path.basename(extractDir)} directory.`);
    execSync(`7z x "${filePath}" "-o${extractDir}"`);
    fs.unlinkSync(filePath);
  });
}

function mergeTakeouts() {
  const takeouts = fs.readdirSync(currentDir, { withFileTypes: true })
    .filter(dirent=> dirent.name.startsWith('takeout') && dirent.isDirectory());

  if(!takeouts.length) return console.log('There are no Google Takeout directories.');

  takeouts.forEach((takeout)=> {
    const takeoutDir = path.resolve(currentDir, takeout.name);
    console.log(`Merging ${takeout.name} with ${path.basename(tmpMergeDir)}`);
    execSync(`rsync -av --crtimes --remove-source-files --exclude=".*" --backup --suffix="-${Date.now()}-duplicate" "${takeoutDir}/" "${tmpMergeDir}/"`);
    execSync(`rm -rf "${takeoutDir}"`);
  });
}

function renameRsyncBackups(directory) {
  const files = readFilesRecursively(directory);
  const regx = /-[0-9]+-duplicate$/;
  const backups = files.filter(file=> regx.test(file));

  if(!backups.length) return console.log(`There are no backup files created by rsync in ${path.basename(directory)} directory.`);

  backups.forEach((file)=> {
    const [ suffix ] = regx.exec(file);
    const [, timestamp ] = suffix.split('-');
    const name = path.basename(file);
    const newName = `duplicate-${timestamp}-${name.replace(regx, '')}`;
    fs.renameSync(file, path.resolve(path.dirname(file), newName));
  });

  console.log(`Renamed ${backups.length} backup files created by rsync in ${path.basename(directory)} directory.`);
}

function fixMetaData(directory) {
  const files = readFilesRecursively(directory)
    .filter(file=> !path.basename(file).startsWith('.'));

  const mediaFiles = files
    .filter(file=> !file.endsWith('.json'));

  const metaDataFiles = files
    .filter(file=> file.endsWith('.json'))
    .map(file=> file.toLowerCase());

  const matches = [];
  for(const file of mediaFiles) {
    const ext = path.extname(file);
    const name = path.basename(file, ext);

    const possibleMatches = [
      name + ext, // file.jpg -> file.jpg.json
      name.replace('-edited', '') + ext, // file-edited.jpg -> file.jpg.json
      name.replace('-collage', '') + ext, // file-collage.jpg -> file.jpg.json
      name.replace(/\(\d+\)/, d=> ext + d), // file(1).jpg -> file.jpg(1).json
      name.replace(/\(\d+\)/, '') + ext, // file(1).jpg -> file.json
    ]
    .flatMap((name)=> {
      return [
        name,
        name.replace(/\.jpg/i, '.heic'), // sometimes metadata for a .jpg file can be in a .heic.json file
        name.replace(/\.heic/i, '.jpg'), // sometimes metadata for a .heic file can be in a .jpg.json file
        name.replace(/\.mov/i, '.heic'), // sometimes metadata for a iOS Live Photos .mov file can be in a .heic.json file
      ];
    })
    .map((name)=> {
      // Google Photos file names are never longer than 46 characters
      return path.resolve(path.dirname(file), `${name.substr(0, 46)}.json`);
    });

    const metaDataFile = possibleMatches.find(file=> metaDataFiles.includes(file.toLowerCase()));
    if(metaDataFile) {
      matches.push({ file, metaDataFile });
    } else {
      console.log(`Unable to locate the metadata file for ${file} file.`);
    }
  }

  if(mediaFiles.length !== matches.length) {
    console.log(`${mediaFiles.length - matches.length} files must have an accompanying metadata file to continue.`);
    return process.exit(1);
  }

  matches.forEach(({ file, metaDataFile }, index)=> {
    const timeStampMs = new Date(parseInt(JSON.parse(fs.readFileSync(metaDataFile, 'utf-8')).photoTakenTime.timestamp, 10) * 1000);
    const creationDate = formatDate(timeStampMs, { year: 'numeric', month: 'numeric', day: 'numeric' });
    const creationTime = formatDate(timeStampMs, { hour: 'numeric', hour12: false, minute: 'numeric', second: 'numeric' });

    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write(`Updating metadata of ${file}. ${index + 1} of ${matches.length}.`);

    execSync(`SetFile -d "${creationDate} ${creationTime}" "${file}"`);
  });

  if(matches.length) {
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write(`Updated metadata of ${matches.length} files.\n`);
  }
}

function mergePhotos() {
  if(!fs.existsSync(tmpPhotosDir)) return;
  const dirents = fs.readdirSync(tmpPhotosDir, { withFileTypes: true });
  const albums = dirents.filter(dirent=> dirent.isDirectory());

  // merging all at once can take a long time so merge album by album
  albums.forEach((album)=> {
    const directory = path.resolve(tmpPhotosDir, album.name);
    const destDirectory = path.resolve(photosDir, album.name);
    console.log(`Merging ${album.name} with ${path.basename(photosDir)}`);
    execSync(`rsync -av --crtimes --remove-source-files --exclude=".*" --backup --suffix="-${Date.now()}-duplicate" "${directory}/" "${destDirectory}/"`);
    execSync(`rm -rf "${directory}"`);
  });
}

function deleteEmptyAlbums() {
  const dirents = fs.readdirSync(photosDir, { withFileTypes: true });
  const albums = dirents.filter(dirent=> dirent.isDirectory());

  albums.forEach((album)=> {
    const directory = path.resolve(photosDir, album.name);
    const files = fs.readdirSync(directory)
      .filter((name)=> {
        if(name.startsWith('.')) return false;
        if(name.endsWith('.json')) return false;
        return true;
      });

    // there should be files other than just dot and json files
    if(!files.length) {
      console.log(`Deleting empty ${album.name} directory.`);
      execSync(`rm -rf "${directory}"`);
    }
  });
}

function deleteTmpMergeDir() {
  if(!fs.existsSync(tmpMergeDir)) return;
  console.log(`Deleting ${path.basename(tmpMergeDir)} directory.`);
  execSync(`rm -rf "${tmpMergeDir}"`);
}

function stampDate() {
  const date = formatDate(new Date(), {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric'
  });

  fs.writeFileSync(path.resolve(currentDir, 'last-takeout.txt'), date);
}

checkTools();
createPhotosDir();
extractTakeouts();
mergeTakeouts();
renameRsyncBackups(tmpMergeDir);
fixMetaData(tmpPhotosDir);
mergePhotos();
renameRsyncBackups(photosDir);
deleteEmptyAlbums();
deleteTmpMergeDir();
stampDate();
