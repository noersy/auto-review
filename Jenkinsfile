pipeline {
    agent any

    options {
        disableConcurrentBuilds()
    }

    triggers {
        GenericTrigger(
            genericVariables: [
                [key: 'GH_ACTION',       value: '$.action'],
                [key: 'GH_REPO',         value: '$.repository.full_name'],
                [key: 'GH_PR_NUMBER',    value: '$.pull_request.number', defaultValue: ''],
                [key: 'GH_COMMENT_BODY', value: '$.comment.body',        defaultValue: ''],
                [key: 'GH_ISSUE_NUMBER', value: '$.issue.number',        defaultValue: ''],
                [key: 'GH_LABEL_NAME',   value: '$.label.name',          defaultValue: ''],
                [key: 'GH_SENDER',       value: '$.sender.login',        defaultValue: ''],
                [key: 'GH_PROVIDER',     value: '$.provider',            defaultValue: 'claude']
            ],
            token: 'headless-agent-webhook',
            causeString: 'PR Event from $GH_REPO using Provider $GH_PROVIDER',
            printContributedVariables: true,
            printPostContent: false
        )
    }

    environment {
        GITHUB_TOKEN = credentials('GITHUB_TOKEN')
        CI = 'true'
        GH_PROVIDER = "gemini"
        CREDENTIALS_REPO = "https://x-access-token:${GITHUB_TOKEN}@github.com/noersy/agent-credentials.git"
    }

    stages {
        stage('Load Credentials') {
            steps {
                script {
                    dir('agent-credentials') {
                        checkout([
                            $class: 'GitSCM',
                            branches: [[name: 'master']],
                            userRemoteConfigs: [[
                                url: "https://x-access-token:${env.GITHUB_TOKEN}@github.com/noersy/agent-credentials.git"
                            ]],
                            extensions: [[$class: 'CleanBeforeCheckout']]
                        ])
                        env.CLAUDE_JSON_CONFIG    = readFile('claude.json').trim()
                        env.GEMINI_OAUTH_JSON     = readFile('gemini-oauth.json').trim()
                        env.GEMINI_SETTINGS_JSON  = readFile('gemini-settings.json').trim()
                    }
                    echo "[CRED] Credentials loaded from agent-credentials repo."
                }
            }
        }

        stage('Checkout Target Repository') {
            when {
                expression {
                    def action = (env.GH_ACTION == 'null' || env.GH_ACTION == null) ? '' : env.GH_ACTION
                    def prNum = (env.GH_PR_NUMBER == 'null' || env.GH_PR_NUMBER == null) ? '' : env.GH_PR_NUMBER
                    if (!action && prNum) action = 'opened'

                    if (!(action in ['opened', 'synchronize', 'created', 'reopened']) &&
                        !(action == 'labeled' && env.GH_LABEL_NAME == 'auto-fix')) {
                        echo "Action '${env.GH_ACTION}' is not handled or label is not auto-fix — skipping pipeline."
                        return false
                    }
                    return true
                }
            }
            steps {
                script {
                    def prNumber = env.GH_PR_NUMBER ?: env.GH_ISSUE_NUMBER
                    if (!prNumber || prNumber == 'null') {
                        error "No PR or Issue number provided by webhook."
                    }

                    def action = (env.GH_ACTION == 'null' || env.GH_ACTION == null) ? '' : env.GH_ACTION
                    if (!action && env.GH_PR_NUMBER && env.GH_PR_NUMBER != 'null') {
                        action = 'opened'
                        env.GH_ACTION = 'opened' // Attempt to set it for subsequent stages
                    }

                    if (action in ['opened', 'synchronize', 'reopened'] && env.GH_PR_NUMBER && env.GH_PR_NUMBER != 'null') {
                        // Flow A: checkout PR merge commit so Claude sees the actual diff
                        echo "Checking out ${env.GH_REPO} PR #${prNumber}..."
                        checkout([
                            $class: 'GitSCM',
                            branches: [[name: "origin/pr/${prNumber}/merge"]],
                            userRemoteConfigs: [[
                                url: "https://x-access-token:${env.GITHUB_TOKEN}@github.com/${env.GH_REPO}.git",
                                refspec: "+refs/pull/${prNumber}/merge:refs/remotes/origin/pr/${prNumber}/merge +refs/heads/*:refs/remotes/origin/*"
                            ]],
                            extensions: [[$class: 'CleanBeforeCheckout']]
                        ])
                    } else if (action == 'labeled' && env.GH_LABEL_NAME == 'auto-fix') {
                        // Flow C: repo is cloned inside the persistent container at /repo — no workspace checkout needed.
                        echo "Issue #${prNumber} Auto-Fix: skipping workspace checkout, repo will be cloned inside container."
                    } else {
                        // Flow B (created / issue_comment) or unsupported action for Issues
                        echo "Flow B (reply) or Issue event: skipping repo checkout."
                    }
                }
            }
        }

        stage('Build Bot Image') {
            when {
                expression {
                    def action = (env.GH_ACTION == 'null' || env.GH_ACTION == null) ? '' : env.GH_ACTION
                    def prNum = (env.GH_PR_NUMBER == 'null' || env.GH_PR_NUMBER == null) ? '' : env.GH_PR_NUMBER
                    if (!action && prNum) action = 'opened'

                    return (action in ['opened', 'synchronize', 'created', 'reopened']) ||
                           (action == 'labeled' && env.GH_LABEL_NAME == 'auto-fix')
                }
            }
            steps {
                // Write credential files before docker build so they exist on host
                // when the container mounts them via -v
                writeFile file: "${env.WORKSPACE}/.claude-credentials.json", text: env.CLAUDE_JSON_CONFIG
                writeFile file: "${env.WORKSPACE}/.gemini-credentials.json", text: env.GEMINI_OAUTH_JSON
                writeFile file: "${env.WORKSPACE}/.gemini-settings.json",    text: env.GEMINI_SETTINGS_JSON

                dir('auto-review-bot') {
                    checkout([
                        $class: 'GitSCM',
                        branches: [[name: 'auto-fix-by-issue']],
                        userRemoteConfigs: [[
                            url: "https://x-access-token:${env.GITHUB_TOKEN}@github.com/noersy/auto-review.git"
                        ]],
                        extensions: [[$class: 'CleanBeforeCheckout']]
                    ])
                    sh "docker build -t auto-review-bot:ci ."
                }
            }
        }

        stage('Run Auto-Review Bot') {
            when {
                expression {
                    def action = (env.GH_ACTION == 'null' || env.GH_ACTION == null) ? '' : env.GH_ACTION
                    def prNum = (env.GH_PR_NUMBER == 'null' || env.GH_PR_NUMBER == null) ? '' : env.GH_PR_NUMBER
                    if (!action && prNum) action = 'opened'

                    return (action in ['opened', 'synchronize', 'created', 'reopened']) ||
                           (action == 'labeled' && env.GH_LABEL_NAME == 'auto-fix')
                }
            }
            steps {
                script {
                    def action = (env.GH_ACTION == 'null' || env.GH_ACTION == null) ? '' : env.GH_ACTION
                    if (!action && env.GH_PR_NUMBER && env.GH_PR_NUMBER != 'null') action = 'opened'

                    def prNumber = (env.GH_PR_NUMBER && env.GH_PR_NUMBER != 'null') ? env.GH_PR_NUMBER : env.GH_ISSUE_NUMBER
                    def containerName = 'auto-review-bot-ci'

                    // Pass comment-body via env var to avoid shell quoting issues
                    withEnv(["BOT_COMMENT_BODY=${env.GH_COMMENT_BODY}", "PROVIDER=${env.GH_PROVIDER}"]) {
                        def containerExists = sh(
                            script: "docker ps -a --filter name=^${containerName}\$ --format '{{.Names}}'",
                            returnStdout: true
                        ).trim()

                        // Always recreate container fresh
                        sh "docker rm -f ${containerName} 2>/dev/null || true"
                        sh """
                            docker run --rm -d --name ${containerName} \\
                                --memory=900m \\
                                --memory-reservation=600m \\
                                -e CI=true \\
                                -e GITHUB_TOKEN="${env.GITHUB_TOKEN}" \\
                                -e BOT_COMMENT_BODY \\
                                -e GOOGLE_GENAI_USE_GCA=true \\
                                -v "${env.WORKSPACE}:/repo:rw" \\
                                auto-review-bot:ci sleep infinity
                        """

                        // Inject credentials via docker cp (avoids bind-mount directory issue)
                        sh """
                            docker exec --user root ${containerName} mkdir -p /home/botuser/.claude /home/botuser/.gemini
                            docker cp "${env.WORKSPACE}/.claude-credentials.json" ${containerName}:/home/botuser/.claude/.credentials.json
                            docker cp "${env.WORKSPACE}/.gemini-credentials.json" ${containerName}:/home/botuser/.gemini/oauth_creds.json
                            docker cp "${env.WORKSPACE}/.gemini-settings.json"    ${containerName}:/home/botuser/.gemini/settings.json
                            docker exec --user root ${containerName} chown -R botuser:botuser /home/botuser/.claude /home/botuser/.gemini
                            echo "[CRED DEBUG] Credentials injected via docker cp"
                            docker exec --user botuser ${containerName} ls -la /home/botuser/.claude/ /home/botuser/.gemini/
                        """

                        // Clone/reset target repo inside container at /repo
                        sh """
                            docker exec --user botuser ${containerName} bash -c  '
                                git config --global --add safe.directory /repo
                                if [ -d /repo/.git ]; then
                                    git -C /repo remote set-url origin https://x-access-token:${env.GITHUB_TOKEN}@github.com/${env.GH_REPO}.git
                                    git -C /repo fetch origin
                                    git -C /repo remote set-head origin -a
                                    DEFAULT_BRANCH=\$(git -C /repo symbolic-ref refs/remotes/origin/HEAD | cut -d/ -f4)
                                    git -C /repo checkout -B \$DEFAULT_BRANCH origin/\$DEFAULT_BRANCH
                                else
                                    git clone https://x-access-token:${env.GITHUB_TOKEN}@github.com/${env.GH_REPO}.git /repo
                                    git -C /repo remote set-head origin -a
                                fi
                            '
                        """

                        sh """
                            docker exec \\
                                --user botuser \\
                                -e GITHUB_TOKEN="${env.GITHUB_TOKEN}" \\
                                ${containerName} bash -c '
                                    git config --global --add safe.directory /app
                                    if [ -d /app/.git ]; then
                                        git -C /app fetch origin
                                        git -C /app checkout -B auto-fix-by-issue origin/auto-fix-by-issue
                                    else
                                        git clone --branch auto-fix-by-issue https://x-access-token:${env.GITHUB_TOKEN}@github.com/noersy/auto-review.git /app
                                        cd /app && npm ci --omit=dev
                                    fi
                                '
                        """

                        sh """
                            docker exec \\
                                --user botuser \\
                                -e GITHUB_TOKEN="${env.GITHUB_TOKEN}" \\
                                -e BOT_COMMENT_BODY="\$BOT_COMMENT_BODY" \\
                                -e CI=true \\
                                -e GOOGLE_GENAI_USE_GCA=true \\
                                ${containerName} \\
                                node /app/src/index.js \\
                                --action "${action}" \\
                                --repo "${env.GH_REPO}" \\
                                --pr "${prNumber}" \\
                                --comment-body "\$BOT_COMMENT_BODY" \\
                                --sender "${env.GH_SENDER}" \\
                                --label-name "${env.GH_LABEL_NAME}" \\
                                --provider "\$PROVIDER"
                        """
                    }
                }
            }
        }
    }

    post {
        always {
            sh """
                docker exec --user botuser auto-review-bot-ci bash -c '
                    git -C /repo checkout HEAD -- . 2>/dev/null || true
                    git -C /repo clean -fd --exclude=".claude-credentials.json" --exclude=".gemini-credentials.json" --exclude=".gemini-settings.json" 2>/dev/null || true
                    git -C /repo checkout \$(git -C /repo remote show origin | grep "HEAD branch" | awk "{print \$NF}") 2>/dev/null || true
                ' 2>/dev/null || true
            """
            sh "rm -rf ${env.WORKSPACE}/agent-credentials 2>/dev/null || true"
            sh "rm -f ${env.WORKSPACE}/.claude-credentials.json ${env.WORKSPACE}/.gemini-credentials.json ${env.WORKSPACE}/.gemini-settings.json 2>/dev/null || true"
        }
        failure {
            echo 'Bot execution FAILED.'
        }
        success {
            script {
                echo 'Bot execution SUCCESS.'
                // Read updated credentials from container (may have been refreshed by OAuth)
                def updatedClaude   = sh(script: "docker exec auto-review-bot-ci cat /home/botuser/.claude/.credentials.json 2>/dev/null || echo ''", returnStdout: true).trim()
                def updatedGemini   = sh(script: "docker exec auto-review-bot-ci cat /home/botuser/.gemini/oauth_creds.json 2>/dev/null || echo ''", returnStdout: true).trim()
                def updatedSettings = sh(script: "docker exec auto-review-bot-ci cat /home/botuser/.gemini/settings.json 2>/dev/null || echo ''", returnStdout: true).trim()

                // Update only if content is non-empty
                if (updatedClaude && updatedGemini) {
                    dir('agent-credentials') {
                        if (updatedClaude)   writeFile file: 'claude.json',          text: updatedClaude
                        if (updatedGemini)   writeFile file: 'gemini-oauth.json',    text: updatedGemini
                        if (updatedSettings) writeFile file: 'gemini-settings.json', text: updatedSettings

                        sh """
                            git config user.email "jenkins@auto-review-bot"
                            git config user.name "Jenkins Auto-Review Bot"
                            git add claude.json gemini-oauth.json gemini-settings.json
                            if ! git diff --cached --quiet; then
                                git commit -m "chore: refresh credentials after successful job build #${env.BUILD_NUMBER}"
                                git push origin master
                                echo "[CRED] Credentials updated in agent-credentials repo."
                            else
                                echo "[CRED] No credential changes detected, skipping push."
                            fi
                        """
                    }
                }
            }
        }
    }
}
