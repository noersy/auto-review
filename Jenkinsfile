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
                [key: 'GH_PR_NUMBER',    value: '$.pull_request.number',   defaultValue: ''],
                [key: 'GH_COMMENT_BODY', value: '$.comment.body',          defaultValue: ''],
                [key: 'GH_ISSUE_NUMBER', value: '$.issue.number',          defaultValue: ''],
                [key: 'GH_LABEL_NAME',   value: '$.label.name',            defaultValue: ''],
                [key: 'GH_SENDER',       value: '$.sender.login',          defaultValue: ''],
                [key: 'GH_MERGED',       value: '$.pull_request.merged',   defaultValue: 'false'],
                [key: 'GH_HEAD_BRANCH',  value: '$.pull_request.head.ref', defaultValue: ''],
                [key: 'GH_PROVIDER',     value: '$.provider',              defaultValue: 'claude']
            ],
            token: 'headless-agent-webhook',
            causeString: 'PR Event from $GH_REPO using Provider $GH_PROVIDER',
            printContributedVariables: true,
            printPostContent: false
        )
    }

    environment {
        GITHUB_TOKEN = credentials('GITHUB_TOKEN')
        CI           = 'true'
        GH_PROVIDER  = 'gemini'
    }

    stages {
        stage('Load Credentials') {
            steps {
                script {
                    dir('agent-credentials') {
                        checkout([
                            $class: 'GitSCM',
                            branches: [[name: 'main']],
                            userRemoteConfigs: [[
                                url: "https://x-access-token:${env.GITHUB_TOKEN}@github.com/noersy/agent-credentials.git"
                            ]],
                            extensions: [[$class: 'CleanBeforeCheckout']]
                        ])
                        env.CLAUDE_JSON_CONFIG   = readFile('claude.json').trim()
                        env.GEMINI_OAUTH_JSON    = readFile('gemini-oauth.json').trim()
                        env.GEMINI_SETTINGS_JSON = readFile('gemini-settings.json').trim()
                    }
                    echo "[CRED] Credentials loaded from agent-credentials repo."
                }
            }
        }

        stage('Resolve Action') {
            steps {
                script {
                    // Normalize nulls from webhook
                    def action     = (env.GH_ACTION     == 'null' || !env.GH_ACTION)     ? '' : env.GH_ACTION
                    def prNum      = (env.GH_PR_NUMBER  == 'null' || !env.GH_PR_NUMBER)  ? '' : env.GH_PR_NUMBER
                    def issueNum   = (env.GH_ISSUE_NUMBER == 'null' || !env.GH_ISSUE_NUMBER) ? '' : env.GH_ISSUE_NUMBER
                    def labelName  = (env.GH_LABEL_NAME == 'null' || !env.GH_LABEL_NAME) ? '' : env.GH_LABEL_NAME
                    def headBranch = (env.GH_HEAD_BRANCH == 'null' || !env.GH_HEAD_BRANCH) ? '' : env.GH_HEAD_BRANCH
                    def merged     = (env.GH_MERGED == 'true')

                    if (!action && prNum) action = 'opened'

                    env.GH_ACTION      = action
                    env.GH_PR_NUMBER   = prNum
                    env.GH_ISSUE_NUMBER = issueNum
                    env.GH_LABEL_NAME  = labelName
                    env.GH_HEAD_BRANCH = headBranch
                    env.GH_MERGED      = merged ? 'true' : 'false'

                    def handled = (action in ['opened', 'synchronize', 'reopened', 'created']) ||
                                  (action == 'labeled' && labelName in ['auto-fix', 'auto-review']) ||
                                  (action == 'closed'  && merged && headBranch)

                    if (!handled) {
                        echo "Action '${action}' (label: '${labelName}') is not handled — aborting pipeline."
                        currentBuild.result = 'NOT_BUILT'
                        error("Unhandled action — stopping early.")
                    }

                    echo "Action resolved: ${action} | PR: ${prNum} | Issue: ${issueNum} | Label: ${labelName} | Merged: ${merged} | Head: ${headBranch}"
                }
            }
        }

        stage('Checkout Target Repository') {
            when {
                expression {
                    // Only Flow A/D need workspace checkout (for /repo mount)
                    // Flow B (reply), Flow C (auto-fix), Flow E (close issue) do not need it
                    def action = env.GH_ACTION
                    return (action in ['opened', 'synchronize', 'reopened']) ||
                           (action == 'labeled' && env.GH_LABEL_NAME == 'auto-review')
                }
            }
            steps {
                script {
                    def prNumber = env.GH_PR_NUMBER
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
                }
            }
        }

        stage('Build Bot Image') {
            steps {
                // Write credential files to workspace so docker cp can inject them
                writeFile file: "${env.WORKSPACE}/.claude-credentials.json", text: env.CLAUDE_JSON_CONFIG
                writeFile file: "${env.WORKSPACE}/.gemini-credentials.json", text: env.GEMINI_OAUTH_JSON
                writeFile file: "${env.WORKSPACE}/.gemini-settings.json",    text: env.GEMINI_SETTINGS_JSON

                dir('auto-review-bot') {
                    checkout([
                        $class: 'GitSCM',
                        branches: [[name: 'main']],
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
            steps {
                script {
                    def action     = env.GH_ACTION
                    def prNumber   = env.GH_PR_NUMBER ?: env.GH_ISSUE_NUMBER
                    def containerName = 'auto-review-bot-ci'

                    withEnv(["BOT_COMMENT_BODY=${env.GH_COMMENT_BODY ?: ''}", "PROVIDER=${env.GH_PROVIDER}"]) {
                        // Always start fresh container
                        sh "docker rm -f ${containerName} 2>/dev/null || true"
                        sh """
                            docker run --rm -d --name ${containerName} \\
                                --memory=900m \\
                                --memory-reservation=600m \\
                                -e CI=true \\
                                -e GITHUB_TOKEN="${env.GITHUB_TOKEN}" \\
                                -e GOOGLE_GENAI_USE_GCA=true \\
                                -v "${env.WORKSPACE}:/repo:rw" \\
                                auto-review-bot:ci sleep infinity
                        """

                        // Wait for container to be ready before issuing exec/cp commands
                        sh """
                            for i in \$(seq 1 10); do
                                docker exec ${containerName} true 2>/dev/null && break
                                echo "Waiting for container to be ready (attempt \$i/10)..."
                                sleep 1
                            done
                            docker exec ${containerName} true || (echo "Container not ready after 10 attempts." && exit 1)
                        """

                        // Inject credentials via docker cp
                        sh """
                            docker cp "${env.WORKSPACE}/.claude-credentials.json" ${containerName}:/home/botuser/.claude/.credentials.json
                            docker cp "${env.WORKSPACE}/.gemini-credentials.json" ${containerName}:/home/botuser/.gemini/oauth_creds.json
                            docker cp "${env.WORKSPACE}/.gemini-settings.json"    ${containerName}:/home/botuser/.gemini/settings.json
                            docker exec --user root ${containerName} chown -R botuser:botuser /home/botuser/.claude /home/botuser/.gemini
                        """

                        // For Flow C (auto-fix): clone target repo inside container at /repo
                        if (action == 'labeled' && env.GH_LABEL_NAME == 'auto-fix') {
                            sh """
                                docker exec --user botuser ${containerName} bash -c '
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
                        }

                        // Setup bot app inside container; skip npm ci if package-lock.json unchanged
                        sh """
                            docker exec --user botuser \\
                                -e GITHUB_TOKEN="${env.GITHUB_TOKEN}" \\
                                ${containerName} bash -c '
                                    git config --global --add safe.directory /app
                                    if [ -d /app/.git ]; then
                                        git -C /app fetch origin
                                        git -C /app checkout -B main origin/main
                                    else
                                        git clone --branch main https://x-access-token:${env.GITHUB_TOKEN}@github.com/noersy/auto-review.git /app
                                    fi
                                    cd /app
                                    LOCK_HASH=\$(sha256sum package-lock.json | cut -d" " -f1)
                                    SAVED_HASH=\$(cat .npm-lock-hash 2>/dev/null || echo "")
                                    if [ "\$LOCK_HASH" != "\$SAVED_HASH" ] || [ ! -d node_modules ]; then
                                        echo "package-lock.json changed or node_modules missing — running npm ci..."
                                        npm ci --omit=dev
                                        echo "\$LOCK_HASH" > .npm-lock-hash
                                    else
                                        echo "package-lock.json unchanged — skipping npm ci."
                                    fi
                                '
                        """

                        // Build node command args
                        def mergedFlag  = env.GH_MERGED == 'true' ? '--merged' : ''
                        def headBranch  = env.GH_HEAD_BRANCH ?: ''

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
                                --provider "\$PROVIDER" \\
                                --head-branch "${headBranch}" \\
                                ${mergedFlag}
                        """

                        // Read back potentially refreshed credentials before container is removed
                        def updatedClaude   = sh(script: "docker exec ${containerName} cat /home/botuser/.claude/.credentials.json 2>/dev/null || echo ''", returnStdout: true).trim()
                        def updatedGemini   = sh(script: "docker exec ${containerName} cat /home/botuser/.gemini/oauth_creds.json 2>/dev/null || echo ''", returnStdout: true).trim()
                        def updatedSettings = sh(script: "docker exec ${containerName} cat /home/botuser/.gemini/settings.json 2>/dev/null || echo ''", returnStdout: true).trim()

                        if (updatedClaude && updatedGemini) {
                            def credDir         = "${env.WORKSPACE}/agent-credentials-update"
                            def claudeEscaped   = updatedClaude.replace("'", "'\\''")
                            def geminiEscaped   = updatedGemini.replace("'", "'\\''")
                            def settingsEscaped = updatedSettings ? updatedSettings.replace("'", "'\\''") : ''

                            sh """
                                rm -rf '${credDir}'
                                git clone 'https://x-access-token:${env.GITHUB_TOKEN}@github.com/noersy/agent-credentials.git' '${credDir}'
                                printf '%s' '${claudeEscaped}'   > '${credDir}/claude.json'
                                printf '%s' '${geminiEscaped}'   > '${credDir}/gemini-oauth.json'
                                printf '%s' '${settingsEscaped}' > '${credDir}/gemini-settings.json'
                                git -C '${credDir}' config user.email 'jenkins@auto-review-bot'
                                git -C '${credDir}' config user.name 'Jenkins Auto-Review Bot'
                                git -C '${credDir}' add claude.json gemini-oauth.json gemini-settings.json
                                if ! git -C '${credDir}' diff --cached --quiet; then
                                    git -C '${credDir}' commit -m 'chore: refresh credentials after successful job build #${env.BUILD_NUMBER}'
                                    git -C '${credDir}' push origin main
                                    echo '[CRED] Credentials updated in agent-credentials repo.'
                                else
                                    echo '[CRED] No credential changes detected, skipping push.'
                                fi
                                rm -rf '${credDir}'
                            """
                        }
                    }
                }
            }
        }
    }

    post {
        always {
            sh "docker rm -f auto-review-bot-ci 2>/dev/null || true"
            sh "rm -rf ${env.WORKSPACE}/agent-credentials 2>/dev/null || true"
            sh "rm -f ${env.WORKSPACE}/.claude-credentials.json ${env.WORKSPACE}/.gemini-credentials.json ${env.WORKSPACE}/.gemini-settings.json 2>/dev/null || true"
        }
        failure {
            echo 'Bot execution FAILED.'
        }
        success {
            echo 'Bot execution SUCCESS.'
        }
    }
}
