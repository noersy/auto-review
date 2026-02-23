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
                [key: 'GH_SENDER',       value: '$.sender.login',        defaultValue: '']
            ],
            token: 'auto-review-trigger',
            causeString: 'PR Event from $GH_REPO',
            printContributedVariables: true,
            printPostContent: false
        )
    }

    environment {
        // Token GitHub untuk membaca PR dan memposting komentar (Secret Text)
        GITHUB_TOKEN = credentials('github-bot-token')
        
        // Konfigurasi Session JSON dari Claude Code (Secret Text atau Secret File)
        CLAUDE_JSON_CONFIG = credentials('claude-cli-session-json')
        
        // Environment untuk memberitahu Claude Code bahwa ini adalah mesin CI non-interaktif
        CI = 'true'
    }

    stages {
        stage('Setup Auth & Workspace') {
            steps {
                script {
                    echo "Setting up Claude Authentication for Jenkins Agent..."
                    
                    // Inject konfigurasi ~/.claude.json ke directory home executor
                    // (Gunakan /home/jenkins/.claude.json jika linux)
                    def claudeConfigPath = "${env.HOME}/.claude.json"
                    writeFile file: claudeConfigPath, text: "${env.CLAUDE_JSON_CONFIG}"
                }
            }
        }

        stage('Checkout Target Repository') {
            steps {
                script {
                    def prNumber = env.GH_PR_NUMBER ?: env.GH_ISSUE_NUMBER
                    if (!prNumber) {
                        error "No PR or Issue number provided by webhook."
                    }
                    echo "Checking out ${env.GH_REPO} PR #${prNumber}..."
                    
                    // Checkout branch spesifik dari PR
                    checkout([
                        $class: 'GitSCM',
                        branches: [[name: "origin/pr/${prNumber}/merge"]],
                        userRemoteConfigs: [[
                            // Pastikan jenkins mempunya akses credential jika repo private
                            url: "https://github.com/${env.GH_REPO}.git"
                        ]],
                        extensions: [[$class: 'CleanBeforeCheckout']]
                    ])
                }
            }
        }

        stage('Run Auto-Review Bot') {
            steps {
                // Di tahap ini, direktori aktif sudah berada di dalam repo target.
                // Kita perlu memanggil bot reviewer. Asumsi script auto-review-bot diletakkan / di clone ke suatu path absolute atau diletakan bersama JENKINS_HOME
                
                // HINT: Jika script 'auto-review-bot' (package.json, src/) berada terpisah dari Target Repo,
                // Pastikan anda merujuk pada absolute path instalasi bot tersebut.
                // Misal: sh "node /opt/auto-review-bot/src/index.js ..."
                
                sh """
                    // Jalankan script NodeJS
                    node index.js \\
                        --action "${env.GH_ACTION}" \\
                        --repo "${env.GH_REPO}" \\
                        --pr "${env.GH_PR_NUMBER ?: env.GH_ISSUE_NUMBER}" \\
                        --comment-body "${env.GH_COMMENT_BODY}" \\
                        --sender "${env.GH_SENDER}"
                """
            }
        }
    }

    post {
        always {
            echo "Membersihkan kredensial..."
            // Hapus session ~/.claude.json untuk keamanan setelah run selesai
            sh "rm -f ${env.HOME}/.claude.json"
        }
        failure {
            echo 'Bot execution FAILED.'
        }
        success {
            echo 'Bot execution SUCCESS.'
        }
    }
}
