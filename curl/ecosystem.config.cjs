module.exports = {
  apps: [
    {
      name: 'curl-web-runner',
      script: './server.js',
      cwd: '/var/www/curl',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        PORT: '3000'
      },
      time: true,
      max_memory_restart: '256M'
    }
  ]
};
