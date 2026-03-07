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
            token: 'new-headless-agent-webhook',
            causeString: 'PR Event from $GH_REPO using Provider $GH_PROVIDER',
            printContributedVariables: true,
            printPostContent: false,
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
                    def action     = (env.GH_ACTION     == 'null' || !env.GH_ACTION)        ? '' : env.GH_ACTION
                    def prNum      = (env.GH_PR_NUMBER  == 'null' || !env.GH_PR_NUMBER)     ? '' : env.GH_PR_NUMBER
                    def issueNum   = (env.GH_ISSUE_NUMBER == 'null' || !env.GH_ISSUE_NUMBER) ? '' : env.GH_ISSUE_NUMBER
                    def labelName  = (env.GH_LABEL_NAME == 'null' || !env.GH_LABEL_NAME)    ? '' : env.GH_LABEL_NAME
                    def headBranch = (env.GH_HEAD_BRANCH == 'null' || !env.GH_HEAD_BRANCH)  ? '' : env.GH_HEAD_BRANCH
                    def merged     = (env.GH_MERGED == 'true')

                    if (!action && prNum) action = 'opened'

                    env.GH_ACTION       = action
                    env.GH_PR_NUMBER    = prNum
                    env.GH_ISSUE_NUMBER = issueNum
                    env.GH_LABEL_NAME   = labelName
                    env.GH_HEAD_BRANCH  = headBranch
                    env.GH_MERGED       = merged ? 'true' : 'false'

                    def isPrAction = action in ['opened', 'synchronize', 'reopened', 'ready_for_review']
                    def handled = (isPrAction && prNum) ||
                                  (action == 'created') ||
                                  (action == 'labeled' && labelName == 'auto-fix') ||
                                  (action == 'labeled' && labelName == 'auto-review' && prNum) ||
                                  (action == 'closed'  && merged && headBranch && prNum)

                    if (!handled) {
                        echo "Action '${action}' (label: '${labelName}', PR: '${prNum}', Issue: '${issueNum}') is not handled — aborting pipeline."
                        currentBuild.result = 'NOT_BUILT'
                        error("Unhandled action — stopping early.")
                    }

                    echo "Action resolved: ${action} | PR: ${prNum} | Issue: ${issueNum} | Label: ${labelName} | Merged: ${merged} | Head: ${headBranch}"

                    // Detect nested overlayfs (DinD scenario).
                    // docker cp into a running container's RWLayer is unreliable on overlayfs-over-overlayfs,
                    // so we use directory bind mounts for credential injection instead.
                    def storageDriver = sh(script: "docker info --format '{{.Driver}}' 2>/dev/null || echo 'unknown'", returnStdout: true).trim()
                    env.DOCKER_USE_VOLUME_MOUNT = (storageDriver == 'overlayfs') ? 'true' : 'false'
                    echo "[DOCKER] Storage driver: ${storageDriver} → USE_VOLUME_MOUNT=${env.DOCKER_USE_VOLUME_MOUNT}"

                    // Resolve the host-side path of WORKSPACE for use in docker volume mounts.
                    // When Jenkins itself runs inside a container with a named volume for /var/jenkins_home,
                    // env.WORKSPACE contains the in-container path (e.g. /var/jenkins_home/workspace/...).
                    // docker run -v uses host paths, so we must map it to the real host path.
                    //
                    // We read /proc/self/mountinfo (always available in Linux, works on cgroup v1 & v2)
                    // to find where /var/jenkins_home is actually mounted from on the host.
                    // This is reliable even when HOSTNAME != container ID (e.g. after container recreation).
                    def jenkinsHomeSrc = sh(
                        script: "grep -oP '/var/lib/docker/volumes/[^/]+/_data' /proc/self/mountinfo | head -1 || echo ''",
                        returnStdout: true
                    ).trim()
                    if (jenkinsHomeSrc) {
                        env.HOST_WORKSPACE = env.WORKSPACE.replace('/var/jenkins_home', jenkinsHomeSrc)
                    } else {
                        env.HOST_WORKSPACE = env.WORKSPACE
                    }
                    echo "[DOCKER] HOST_WORKSPACE resolved to: ${env.HOST_WORKSPACE}"
                }
            }
        }

        stage('Checkout Target Repository') {
            when {
                expression {
                    // Only Flow A/D need workspace checkout (for /repo mount)
                    def action = env.GH_ACTION
                    return (action in ['opened', 'synchronize', 'reopened', 'ready_for_review']) ||
                           (action == 'labeled' && env.GH_LABEL_NAME == 'auto-review')
                }
            }
            steps {
                script {
                    def prNumber = env.GH_PR_NUMBER
                    echo "Checking out ${env.GH_REPO} PR #${prNumber}..."
                    dir('target-repo') {
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
        }

        stage('Build Bot Image') {
            steps {
                script {
                    def useVolumeMount = env.DOCKER_USE_VOLUME_MOUNT == 'true'

                    if (useVolumeMount) {
                        // DinD strategy: write credentials into subdirectory mirrors of the
                        // container's home layout. Entire directories are bind-mounted so
                        // Docker inherits the host directory ownership instead of creating
                        // root-owned entries (which happens when mounting individual files on overlayfs).
                        sh "mkdir -p '${env.WORKSPACE}/.creds/claude' '${env.WORKSPACE}/.creds/gemini'"
                        writeFile file: "${env.WORKSPACE}/.creds/claude/.credentials.json", text: env.CLAUDE_JSON_CONFIG
                        writeFile file: "${env.WORKSPACE}/.creds/gemini/oauth_creds.json",  text: env.GEMINI_OAUTH_JSON
                        writeFile file: "${env.WORKSPACE}/.creds/gemini/settings.json",     text: env.GEMINI_SETTINGS_JSON
                        sh "chmod -R 777 '${env.WORKSPACE}/.creds'"
                    } else {
                        // Native Docker strategy: flat files for docker cp
                        writeFile file: "${env.WORKSPACE}/.claude-credentials.json", text: env.CLAUDE_JSON_CONFIG
                        writeFile file: "${env.WORKSPACE}/.gemini-credentials.json", text: env.GEMINI_OAUTH_JSON
                        writeFile file: "${env.WORKSPACE}/.gemini-settings.json",    text: env.GEMINI_SETTINGS_JSON
                    }

                    sh "rm -rf '${env.WORKSPACE}/auto-review-bot'"
                    dir('auto-review-bot') {
                        checkout([
                            $class: 'GitSCM',
                            branches: [[name: 'new-fix-by-issue']],
                            userRemoteConfigs: [[
                                url: "https://x-access-token:${env.GITHUB_TOKEN}@github.com/noersy/auto-review.git"
                            ]]
                        ])
                        sh "docker build -t auto-review-bot:ci ."
                    }
                }
            }
        }

        stage('Run Auto-Review Bot') {
            steps {
                script {
                    def action         = env.GH_ACTION
                    def prRaw          = env.GH_PR_NUMBER ?: ''
                    def issueRaw       = env.GH_ISSUE_NUMBER ?: ''
                    // Generic Webhook Trigger returns '0' (not '') when a numeric JSONPath
                    // (e.g. $.pull_request.number) is missing — '0' is truthy in Groovy,
                    // so we must explicitly treat it as empty to allow fallback to issueRaw.
                    def prNumber       = (prRaw == '0' || prRaw == '') ? issueRaw : prRaw
                    def containerName  = 'auto-review-bot-ci'
                    def useVolumeMount = env.DOCKER_USE_VOLUME_MOUNT == 'true'

                    withEnv(["PROVIDER=${env.GH_PROVIDER}"]) {
                        // Write comment body to a file to avoid shell injection via special chars.
                        // Remove first in case a previous failed run left a directory with this name.
                        def commentBodyFile = "${env.WORKSPACE}/.bot-comment-body.txt"
                        sh "rm -rf '${commentBodyFile}'"
                        writeFile file: commentBodyFile, text: env.GH_COMMENT_BODY ?: ''

                        sh "mkdir -p '${env.WORKSPACE}/target-repo'"

                        // Always start fresh; wait for any in-progress removal to finish
                        sh "docker rm -f ${containerName} 2>/dev/null || true"
                        sh "timeout 15 bash -c 'while docker inspect ${containerName} >/dev/null 2>&1; do sleep 1; done' || true"

                        if (useVolumeMount) {
                            // DinD / nested overlayfs: mount entire credential directories.
                            // Mounting individual files causes root:root ownership on overlayfs,
                            // which makes the container crash immediately (botuser cannot access them).
                            // Directory mounts inherit the host directory's ownership correctly.
                            // Use HOST_WORKSPACE (resolved host-side path) for -v flags since
                            // WORKSPACE is an in-container path inside the Jenkins container.
                            echo "[DOCKER] Using volume-mount strategy for credential injection."
                            sh """
                                docker run --rm -d --name ${containerName} \\
                                    --memory=900m \\
                                    --memory-reservation=600m \\
                                    -e CI=true \\
                                    -e GOOGLE_GENAI_USE_GCA=true \\
                                    -v "${env.HOST_WORKSPACE}/target-repo:/repo:rw" \\
                                    -v "${env.HOST_WORKSPACE}/.creds/claude:/home/botuser/.claude:rw" \\
                                    -v "${env.HOST_WORKSPACE}/.creds/gemini:/home/botuser/.gemini:rw" \\
                                    auto-review-bot:ci sleep infinity
                            """
                        } else {
                            // Native Docker: credentials injected via docker cp after container starts
                            echo "[DOCKER] Using docker cp strategy for credential injection."
                            sh """
                                docker run --rm -d --name ${containerName} \\
                                    --memory=900m \\
                                    --memory-reservation=600m \\
                                    -e CI=true \\
                                    -e GOOGLE_GENAI_USE_GCA=true \\
                                    -v "${env.HOST_WORKSPACE}/target-repo:/repo:rw" \\
                                    auto-review-bot:ci sleep infinity
                            """
                        }

                        // Wait for container to be ready
                        sh """
                            for i in \$(seq 1 10); do
                                docker exec ${containerName} true 2>/dev/null && break
                                echo "Waiting for container to be ready (attempt \$i/10)..."
                                sleep 1
                            done
                            docker exec ${containerName} true || (echo "Container not ready after 10 attempts." && exit 1)
                        """

                        if (useVolumeMount) {
                            sh """
                                docker cp "${commentBodyFile}" ${containerName}:/home/botuser/.bot-comment-body.txt
                                docker exec --user root ${containerName} chown botuser:botuser /home/botuser/.bot-comment-body.txt
                            """
                        } else {
                            // Native Docker: inject credentials and comment body via docker cp
                            sh """
                                docker cp "${env.WORKSPACE}/.claude-credentials.json"  ${containerName}:/home/botuser/.claude/.credentials.json
                                docker cp "${env.WORKSPACE}/.gemini-credentials.json"  ${containerName}:/home/botuser/.gemini/oauth_creds.json
                                docker cp "${env.WORKSPACE}/.gemini-settings.json"     ${containerName}:/home/botuser/.gemini/settings.json
                                docker cp "${commentBodyFile}"                          ${containerName}:/home/botuser/.bot-comment-body.txt
                                docker exec --user root ${containerName} chown -R botuser:botuser /home/botuser/.claude /home/botuser/.gemini /home/botuser/.bot-comment-body.txt
                            """
                        }

                        // For Flow C (auto-fix): clone target repo inside container at /repo.
                        // /repo is bind-mounted from the Jenkins workspace which may contain
                        // non-git files (.creds/, .bot-comment-body.txt, etc.), so we cannot
                        // rely on absence of /repo or presence of /repo/.git. Instead:
                        // - If /repo/.git exists: update in-place (already a valid clone)
                        // - Otherwise: clone into a temp dir then move contents into /repo
                        if (action == 'labeled' && env.GH_LABEL_NAME == 'auto-fix') {
                            // /repo is bind-mounted from the Jenkins workspace; files may be owned
                            // by the Jenkins process user, not botuser. Fix ownership so botuser
                            // can write to .git/ and clone into /repo.
                            sh "docker exec --user root ${containerName} chown -R botuser:botuser /repo"

                            sh """
                                docker exec --user botuser ${containerName} bash -c '
                                    git config --global --add safe.directory /repo
                                    if [ -d /repo/.git ]; then
                                        git -C /repo remote set-url origin https://x-access-token:${env.GITHUB_TOKEN}@github.com/${env.GH_REPO}.git
                                        git -C /repo fetch origin
                                        git -C /repo reset --hard HEAD
                                        git -C /repo clean -fd
                                        git -C /repo remote set-head origin -a
                                        DEFAULT_BRANCH=\$(git -C /repo symbolic-ref refs/remotes/origin/HEAD | cut -d/ -f4)
                                        git -C /repo checkout -B \$DEFAULT_BRANCH origin/\$DEFAULT_BRANCH
                                    else
                                        git clone https://x-access-token:${env.GITHUB_TOKEN}@github.com/${env.GH_REPO}.git /tmp/repo-clone
                                        cp -a /tmp/repo-clone/. /repo/
                                        rm -rf /tmp/repo-clone
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
                                        git -C /app checkout -B new-fix-by-issue origin/new-fix-by-issue
                                    else
                                        git clone --branch new-fix-by-issue https://x-access-token:${env.GITHUB_TOKEN}@github.com/noersy/auto-review.git /app
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
                        def mergedFlag = env.GH_MERGED == 'true' ? '--merged' : ''
                        def headBranch = env.GH_HEAD_BRANCH ?: ''

                        sh """
                            docker exec \\
                                --user botuser \\
                                -e GITHUB_TOKEN="${env.GITHUB_TOKEN}" \\
                                -e CI=true \\
                                -e GOOGLE_GENAI_USE_GCA=true \\
                                -e REPO_DIR=/repo \\
                                ${containerName} \\
                                node /app/src/index.js \\
                                --action "${action}" \\
                                --repo "${env.GH_REPO}" \\
                                --pr "${prNumber}" \\
                                --comment-body-file /home/botuser/.bot-comment-body.txt \\
                                --sender "${env.GH_SENDER}" \\
                                --label-name "${env.GH_LABEL_NAME}" \\
                                --provider "\$PROVIDER" \\
                                --head-branch "${headBranch}" \\
                                ${mergedFlag}
                        """

                        // Read back potentially refreshed credentials before container is removed.
                        // Volume-mount: .creds/ dirs are bind-mounted rw, changes are already on host.
                        // docker cp: copy files back from the container.
                        def tmpClaude   = "${env.WORKSPACE}/.updated-claude.json"
                        def tmpGemini   = "${env.WORKSPACE}/.updated-gemini.json"
                        def tmpSettings = "${env.WORKSPACE}/.updated-settings.json"

                        if (useVolumeMount) {
                            sh "cp '${env.WORKSPACE}/.creds/claude/.credentials.json' '${tmpClaude}' 2>/dev/null || true"
                            sh "cp '${env.WORKSPACE}/.creds/gemini/oauth_creds.json'  '${tmpGemini}' 2>/dev/null || true"
                            sh "cp '${env.WORKSPACE}/.creds/gemini/settings.json'     '${tmpSettings}' 2>/dev/null || true"
                        } else {
                            sh "docker cp ${containerName}:/home/botuser/.claude/.credentials.json ${tmpClaude} 2>/dev/null || true"
                            sh "docker cp ${containerName}:/home/botuser/.gemini/oauth_creds.json  ${tmpGemini} 2>/dev/null || true"
                            sh "docker cp ${containerName}:/home/botuser/.gemini/settings.json     ${tmpSettings} 2>/dev/null || true"
                        }

                        def updatedClaude   = fileExists(tmpClaude)   ? readFile(tmpClaude).trim()   : ''
                        def updatedGemini   = fileExists(tmpGemini)   ? readFile(tmpGemini).trim()   : ''
                        def updatedSettings = fileExists(tmpSettings) ? readFile(tmpSettings).trim() : ''

                        if (updatedClaude && updatedGemini) {
                            def credDir = "${env.WORKSPACE}/agent-credentials-update"
                            sh """
                                rm -rf '${credDir}'
                                git clone 'https://x-access-token:${env.GITHUB_TOKEN}@github.com/noersy/agent-credentials.git' '${credDir}'
                            """
                            writeFile file: "${credDir}/claude.json",          text: updatedClaude
                            writeFile file: "${credDir}/gemini-oauth.json",    text: updatedGemini
                            writeFile file: "${credDir}/gemini-settings.json", text: updatedSettings ?: ''
                            sh """
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
            sh "rm -rf '${env.WORKSPACE}/agent-credentials' '${env.WORKSPACE}/.creds' '${env.WORKSPACE}/.bot-comment-body.txt' '${env.WORKSPACE}/target-repo' 2>/dev/null || true"
            sh "rm -f '${env.WORKSPACE}/.claude-credentials.json' '${env.WORKSPACE}/.gemini-credentials.json' '${env.WORKSPACE}/.gemini-settings.json' '${env.WORKSPACE}/.updated-claude.json' '${env.WORKSPACE}/.updated-gemini.json' '${env.WORKSPACE}/.updated-settings.json' 2>/dev/null || true"
        }
        failure {
            echo 'Bot execution FAILED.'
        }
        success {
            echo 'Bot execution SUCCESS.'
        }
    }
}
