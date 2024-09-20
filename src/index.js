require('dotenv').config();

const http = require('http');
const cluster = require('cluster');
const { S3 } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const log4js = require('log4js');

const _port = parseInt(process.env.PORT);
const _host = process.env.LISTEN;
let is_shutdown = false;
const DEFAULT_CACHE = process.env.DEFAULT_CACHE || 'public, max-age=86400';

log4js.configure({
  appenders: {
    out: {
      type: 'stdout',
      layout: {
        type: process.env.LOG_TYPE || 'basic',
        pattern: process.env.LOG_PATTERN || ''
      }
    }
  },
  categories: { default: { appenders: ['out'], level: process.env.LOG_LEVEL || 'info' } }
});

const logger = log4js.getLogger(process.env.SERVICE_NAME);

async function main() {
  const client = new S3({
    endpoint: {
      url: process.env.S3_ENDPOINT_URL,
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'YES',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
    region: process.env.S3_REGION,
  });

  const server = http.createServer(async (req, res) => {
    if (is_shutdown) {
      res.statusCode = 503;
      res.setHeader('Retry-After', 25);
      res.end();
      return;
    }

    const reqPath = req.url.substring(1);

    if (!reqPath.length) {
      res.socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    try {
      const object = await client.getObject({
        Bucket: process.env.S3_BUCKET,
        Key: reqPath,
      });

      if (object.ContentType) {
        res.setHeader('Content-Type', object.ContentType);
      }
      if (object.ContentLength) {
        res.setHeader('Content-Length', object.ContentLength);
      }
      if (object.ETag) {
        res.setHeader('ETag', object.ETag);
      }

      res.setHeader(
        'Cache-Control',
        object.CacheControl ? object.CacheControl : DEFAULT_CACHE,
      );

      object.Body.pipe(res);
      return;
    } catch (err) {
      if (err.Code !== 'NoSuchKey') {
        res.socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        return;
      }
    }

    const reqPathArr = reqPath.split('/');
    const resize_op = reqPathArr[reqPathArr.length - 2].toLowerCase();

    if (resize_op !== 'width' && resize_op !== 'height') {
      res.socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }

    const size = parseInt(reqPathArr[reqPathArr.length - 1]);
    if (isNaN(size) || size < 1 || size > 7680) {
      res.socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    const originalPath = reqPathArr.slice(0, -2).join('/');

    try {
      const object = await client.getObject({
        Bucket: process.env.S3_BUCKET,
        Key: originalPath,
      });

      const originalContentType = object.ContentType.toLowerCase();
      let resizedContentType = object.ContentType;
      let result;

      if (originalContentType === 'image/svg+xml') {
        resizedContentType = 'image/png';
        result = await sharp(await object.Body.transformToByteArray()).resize({
          [resize_op]: size,
        }).rotate().png().toBuffer();
      } else if (originalContentType.indexOf('image/') === 0) {
        result = await sharp(await object.Body.transformToByteArray()).resize({
          [resize_op]: size,
        }).rotate().toBuffer();
      } else {
        res.socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }

      await client.putObject({
        Bucket: process.env.S3_BUCKET,
        Key: `${originalPath}/${resize_op}/${size}`,
        ContentType: resizedContentType,
        CacheControl: object.CacheControl ? object.CacheControl : DEFAULT_CACHE,
        Body: result,
      });

      res.setHeader('Content-Type', resizedContentType);
      res.setHeader('Content-Length', result.length);
      res.setHeader(
        'Cache-Control',
        object.CacheControl ? object.CacheControl : DEFAULT_CACHE,
      );

      res.write(result);
      res.end();

      return;
    } catch (err) {
      if (err.Code === 'NoSuchKey') {
        res.socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        return;
      }

      res.socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      return;
    }
  });

  server.on('clientError', (err, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) {
      return;
    }
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.listen(_port, _host, () => {
    if (process.send) process.send('ready');
  });

  ['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(sig => {
    process.on(sig, () => {
      is_shutdown = true;

      setTimeout(() => {
        process.exit();
      }, 60000);

      server.close((err) => {
        if (err) {
          logger.error(err);
        }

        process.exit();
      });
    });
  });
}

if (cluster.isMaster) {
  const workers = process.env.THREADS ? parseInt(process.env.THREADS) : 1;

  for (let i = 0; i < workers; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    if (code !== 0) {
      logger.info(`worker ${worker.process.pid} died (${code}/${signal})`);
      cluster.fork();
      return;
    }

    logger.info(`worker ${worker.process.pid} shutdown`);
  });

  const sigs = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

  sigs.forEach(sig => {
    process.on(sig, () => {
      logger.info('server being shutdown by: ' + sig);
    });
  });
} else {
  logger.info(`worker ${process.pid} is running`);
  main();
}
