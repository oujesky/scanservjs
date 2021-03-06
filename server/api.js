const log = require('loglevel').getLogger('Api');
const Config = require('../config/config');
const Constants = require('./constants');
const Context = require('./context');
const Devices = require('./devices');
const FileInfo = require('./file-info');
const Process = require('./process');
const Request = require('./request');
const Scanimage = require('./scanimage');
const util = require('./util');

class Api {
  static async fileList() {
    log.debug('fileList()');
    const dir = new FileInfo(Config.outputDirectory);
    let files = await dir.list();
    files = files
      .filter(f => ['.tif', '.jpg', '.png', '.pdf', '.txt', '.zip'].includes(f.extension))
      .sort((f1, f2) => f2.lastModified - f1.lastModified);
    log.debug(JSON.stringify(files));
    return files;
  }

  static fileDelete(fullpath) {
    const file = new FileInfo(fullpath);
    const parent = new FileInfo(file.path);
    const data = new FileInfo(Config.outputDirectory);
    if (!parent.equals(data)) {
      throw new Error('Cannot delete outside of data directory');
    }
    return file.delete();
  }

  static async createPreview(req) {
    const context = await Context.create();
    const request = new Request(context).extend({
      params: {
        deviceId: req.params.deviceId,
        mode: req.params.mode,
        resolution: Config.previewResolution,
        brightness: req.params.brightness,
        contrast: req.params.contrast,
        dynamicLineart: req.params.dynamicLineart
      }
    });

    const cmd = `${Scanimage.scan(request)} > ${Config.previewDirectory}preview.tif`;
    log.debug('Executing cmd:', cmd);
    await Process.spawn(cmd);
    return {};
  }

  static async readPreview() {
    // The UI relies on this image being the correct aspect ratio. If there is a
    // preview image then just use it. 
    const source = new FileInfo(`${Config.previewDirectory}preview.tif`);
    if (source.exists()) {
      const buffer = source.toBuffer();
      return await Process.chain(Config.previewPipeline.commands, buffer, { ignoreErrors: true });
    }

    // If not then it's possible the default image is not quite the correct aspect ratio
    const buffer = new FileInfo(`${Config.previewDirectory}default.jpg`).toBuffer();

    // We need to know the correct AR from the device
    const context = await Context.create();
    const device = context.getDevice();
    const heightByWidth = device.features['-y'].limits[1] / device.features['-x'].limits[1];
    const width = 868;
    const height = Math.round(width * heightByWidth);
    return await Process.spawn(`convert - -resize ${width}x${height}! jpg:-`, buffer);
  }

  static async scan(req) {
    const context = await Context.create();
    const request = new Request(context).extend(req);
    const dir = FileInfo.create(Config.tempDirectory);

    // Check pipeline here. Better to find out sooner if there's a problem
    const pipeline = context.pipelines.filter(p => p.description === request.pipeline)[0];
    if (pipeline === undefined) {
      throw Error('No matching pipeline');
    }

    const clearTemp = async () => {
      const files = await dir.list();
      files.map(f => f.delete());
    };

    if (request.page === 1) {
      log.debug('Clearing temp directory');
      await clearTemp();
    }

    if (request.page > 0) {
      log.debug('Scanning');
      await Process.spawn(Scanimage.scan(request));
    }

    if (request.batch !== Constants.BATCH_MANUAL || request.page < 1) {
      log.debug(`Post processing: ${pipeline.description}`);
      const files = await dir.list();
      const stdin = files
        .filter(f => f.extension === '.tif')
        .map(f => f.name)
        .join('\n');
      log.debug('Executing cmds:', pipeline.commands);
      const stdout = await Process.chain(pipeline.commands, stdin, { cwd: Config.tempDirectory });
      let filenames = stdout.toString().split('\n').filter(f => f.length > 0);

      let filename = filenames[0];
      let extension = pipeline.extension;
      if (filenames.length > 1) {
        filename = 'archive.zip';
        extension = 'zip';
        util.zip(
          filenames.map(f => `${Config.tempDirectory}${f}`),
          `${Config.tempDirectory}${filename}`);
      }

      const destination = `${Config.outputDirectory}${Config.filename()}.${extension}`;
      await FileInfo
        .create(`${Config.tempDirectory}${filename}`)
        .move(destination);

      log.debug(`Written data to: ${destination}`);
      await clearTemp();
      return {};
    }

    log.debug(`Scan page: ${request.page + 1}?`);
    return {
      page: request.page + 1
    };
  }

  static async context(force) {
    if (force) {
      Devices.reset();
      const preview = new FileInfo(`${Config.previewDirectory}preview.tif`);
      preview.delete();
    }
    return await Context.create();
  }
}

module.exports = Api;