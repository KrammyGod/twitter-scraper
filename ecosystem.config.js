module.exports = {
  apps: [{
    name: 'twitter-scraper',
    script: 'index.js',
    node_args: '--env-file=.env',
    time: true,
    exec_mode: 'fork',
    kill_timeout: 10_000, // Wait 10 seconds before force killing
    shutdown_with_message: true,
  }],

  deploy: {
    production: {
      'user': process.env.SSH_USER,
      'host': process.env.SSH_HOST,
      'ref': 'origin/main',
      'repo': 'git@github.com:KrammyGod/twitter-scraper.git',
      'path': process.env.DEPLOY_PATH,
      'post-deploy': 'npm i --omit=dev && pm2 start --env production',
    },
  },
};
