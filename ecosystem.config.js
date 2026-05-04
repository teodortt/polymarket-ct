module.exports = {
    apps: [
        {
            name: "polymarket-copybot",
            script: "./src/index.ts",
            interpreter: "tsx",
            watch: false,
            restart_delay: 5000,
            max_restarts: 10,
            node_args: "--no-deprecation",
            env: {
                NODE_ENV: "production"
            },
            error_file: "./logs/error.log",
            out_file: "./logs/out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss"
        },
        {
            name: "autopull",
            script: "./scripts/autopull.sh",
            interpreter: "bash",
            watch: false,
            restart_delay: 10000,
            env: {
                DEPLOY_BRANCH: "main",
                DEPLOY_POLL_INTERVAL: "60"
            },
            error_file: "./logs/autopull.error.log",
            out_file: "./logs/autopull.out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss"
        }
    ]
};
