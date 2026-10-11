param([ValidateSet('encrypt','decrypt')][string]$Operation)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Security
    $taskBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
    $taskEntropy = [Text.Encoding]::UTF8.GetBytes('photo-digital-human-chatgpt-v1')
    if ($Operation -eq 'encrypt') {
        $taskResult = [Security.Cryptography.ProtectedData]::Protect($taskBytes, $taskEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    } else {
        $taskResult = [Security.Cryptography.ProtectedData]::Unprotect($taskBytes, $taskEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    }
    [Console]::Out.Write([Convert]::ToBase64String($taskResult))
} catch { exit 1 }
