#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const currentDir = process.cwd();
const photosDir = path.resolve(currentDir, 'Google Photos');
const tmpMergeDir = path.resolve(currentDir, 'Temporary Merged Takeout');
const tmpPhotosDir = path.resolve(tmpMergeDir, 'Takeout/Google Photos');

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

function formatDate(date, options = {}) {
  return new Intl.DateTimeFormat('en-US', options).format(date);
}

function createPhotosDir() {
  if(fs.existsSync(photosDir)) return;
  fs.mkdirSync(photosDir);
}

function extractTakeouts() {
  const files = fs.readdirSync(currentDir);
  const zips = files.filter(f=> f.startsWith('takeout') && f.endsWith('.zip'));
  if(!zips.length) return console.log('There are no Google Takeout zip files.');

  zips.forEach(file=> {
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

  takeouts.forEach(takeout=> {
    const takeoutDir = path.resolve(currentDir, takeout.name);
    console.log(`Merging ${takeout.name} with ${path.basename(tmpMergeDir)}`);
    execSync(`rsync -av --crtimes --remove-source-files --exclude=".*" --backup --suffix="-${Date.now()}-duplicate" "${takeoutDir}/" "${tmpMergeDir}/"`);
    execSync(`rm -rf "${takeoutDir}"`);
  });
}

function readFilesRecursively(directory) {
  if(!fs.existsSync(directory)) return [];
  const dirents = fs.readdirSync(directory, { withFileTypes: true });
  return dirents.flatMap(dirent=> {
    const direntPath = path.resolve(directory, dirent.name);
    return dirent.isDirectory() ? readFilesRecursively(direntPath) : direntPath;
  });
}

function renameRsyncBackups(directory) {
  const files = readFilesRecursively(directory);
  const regx = /\-[0-9]+\-duplicate$/;
  const backups = files.filter(file=> regx.test(file));

  if(!backups.length) return console.log(`There are no backup files created by rsync in ${path.basename(directory)} directory.`);

  backups.forEach(file=> {
    const [ suffix ] = regx.exec(file);
    const [, timestamp ] = suffix.split('-');
    const name = path.basename(file);
    const newName = `duplicate-${timestamp}-${name.replace(regx, '')}`;
    fs.renameSync(file, path.resolve(path.dirname(file), newName));
  });

  console.log(`Renamed ${backups.length} backup files created by rsync in ${path.basename(directory)} directory.`);
}

function updateDates(directory) {
  const files = readFilesRecursively(directory);
  const jsonFiles = files.filter(file=> file.endsWith('.json'));
  const filesToUpdate = files.filter(file=> {
    const name = path.basename(file);
    if(name.startsWith('.')) return false;
    if(name.endsWith('.json')) return false;
    return true;
  });

  const filesWithMeta = [];
  filesToUpdate.forEach(file=> {
    const dir = path.dirname(file);
    const name = path.basename(file);
    const extension = path.extname(name);
    const nameWithoutExtension = path.basename(file, extension);
    const possibleMetadata = [
      `${name}.json`,
      `${nameWithoutExtension.replace('(1)', '')}${extension}(1).json`,
      `${nameWithoutExtension.replace('(2)', '')}${extension}(2).json`,
      `${nameWithoutExtension.replace('(3)', '')}${extension}(3).json`,
      `${nameWithoutExtension.replace('(4)', '')}${extension}(4).json`,
      `${nameWithoutExtension.replace('(5)', '')}${extension}(5).json`,
      `${nameWithoutExtension.replace('(6)', '')}${extension}(6).json`,
      `${nameWithoutExtension.replace('(7)', '')}${extension}(7).json`,
      `${name.replace('(1)', '')}.json`,
      `${name.replace('(2)', '')}.json`,
      `${nameWithoutExtension.replace('-edited', '')}${extension}.json`,
      `${nameWithoutExtension.replace('-edited', '')}${extension.toUpperCase()}.json`,
      `${nameWithoutExtension.replace('-COLLAGE', '')}${extension}.json`,
      `${nameWithoutExtension.replace('-COLLAGE', '')}${extension.toUpperCase()}.json`,
      `${name.substr(0, 46)}.json`,
      `${name.replace('(1)', '').substr(0, 46)}.json`,
      `${name.replace('(2)', '').substr(0, 46)}.json`
    ].map(name=> path.resolve(dir, name));

    const metaFile = possibleMetadata.find(file=> jsonFiles.includes(file));
    if(!metaFile) return console.log(`Unable to locate the metadata file for ${file} file.`);
    filesWithMeta.push([file, metaFile]);
  });

  if(filesWithMeta.length !== filesToUpdate.length) {
    console.log(`${filesToUpdate.length - filesWithMeta.length} files must have an accompanying metadata file to continue.`);
    return process.exit(1);
  }

  filesWithMeta.forEach(([file, metaFile], index)=> {
    const cdate = new Date(parseInt(JSON.parse(fs.readFileSync(metaFile, 'utf-8')).photoTakenTime.timestamp, 10) * 1000);

    const creationDate = formatDate(cdate, { year: 'numeric', month: 'numeric', day: 'numeric' });
    const creationTime = formatDate(cdate, { hour: 'numeric', hour12: false, minute: 'numeric', second: 'numeric' });

    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write(`Updating metadata of ${file}. ${index + 1} of ${filesWithMeta.length}.`);

    execSync(`SetFile -d "${creationDate} ${creationTime}" "${file}"`);
  });

  if(filesWithMeta.length) {
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write(`Updated metadata of ${filesWithMeta.length} files.\n`);
  }
}

function mergePhotos() {
  if(!fs.existsSync(tmpPhotosDir)) return;
  const dirents = fs.readdirSync(tmpPhotosDir, { withFileTypes: true });
  const albums = dirents.filter(dirent=> dirent.isDirectory());

  // merging all at once can take a long time so merge album by album
  albums.forEach(album=> {
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

  albums.forEach(album=> {
    const directory = path.resolve(photosDir, album.name);
    const files = fs.readdirSync(directory)
      .filter(name=> {
        if(name.startsWith('.')) return false;
        if(name.endsWith('.json')) return false;
        return true;
      });

    // there should be files other than dotfiles and json files
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

function writeDate() {
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
updateDates(tmpPhotosDir);
mergePhotos();
renameRsyncBackups(photosDir);
deleteEmptyAlbums();
deleteTmpMergeDir();
writeDate();
