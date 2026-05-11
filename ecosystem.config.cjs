const path = require('path');

const backendRoot = __dirname;

module.exports = {
  apps: [
    {
      name: 'callto-backend',
      script: path.join(backendRoot, 'index.js'),
      cwd: backendRoot,
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
