const path = require("path");

const APP_ROOT = __dirname;
const PM2_HOME = process.env.PM2_HOME || path.join(process.env.HOME || "", ".pm2");
const PM2_LOG_DIR = path.join(PM2_HOME, "logs");

module.exports = {
    apps: [
        {
            name: "polymarket-copybot",
            cwd: APP_ROOT,
            script: path.join(APP_ROOT, "src/index.ts"),
            interpreter: "tsx",
            watch: false,
            restart_delay: 5000,
            max_restarts: 10,
            node_args: "--no-deprecation",
            env: {
                NODE_ENV: "production",
                DRY_RUN: "false"
            },
            error_file: path.join(PM2_LOG_DIR, "polymarket-copybot-error.log"),
            out_file: path.join(PM2_LOG_DIR, "polymarket-copybot-out.log"),
            log_date_format: "YYYY-MM-DD HH:mm:ss"
        },
        {
            name: "autopull",
            cwd: APP_ROOT,
            script: path.join(APP_ROOT, "scripts/autopull.sh"),
            interpreter: "bash",
            watch: false,
            restart_delay: 10000,
            env: {
                DEPLOY_POLL_INTERVAL: "60"
            },
            error_file: path.join(PM2_LOG_DIR, "autopull-error.log"),
            out_file: path.join(PM2_LOG_DIR, "autopull-out.log"),
            log_date_format: "YYYY-MM-DD HH:mm:ss"
        }
    ]
};
