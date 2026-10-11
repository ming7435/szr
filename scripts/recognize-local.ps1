param([Parameter(Mandatory=$true)][string]$AudioPath, [switch]$Diagnostics)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$recognizer = $null
try {
    Add-Type -AssemblyName System.Speech
    $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine([System.Globalization.CultureInfo]::GetCultureInfo('zh-CN'))
    $recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $recognizer.InitialSilenceTimeout = [TimeSpan]::FromSeconds(4)
    $recognizer.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(500)
    $recognizer.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(700)
    $recognizer.SetInputToWaveFile($AudioPath)
    $pieces = New-Object System.Collections.Generic.List[string]
    while ($true) {
        try { $result = $recognizer.Recognize([TimeSpan]::FromSeconds(35)) }
        catch {
            # At end of a wave file System.Speech releases its audio input.
            if ($_.Exception.InnerException -is [System.InvalidOperationException]) { break }
            throw
        }
        if ($null -eq $result) { break }
        if ($result.Text -and $result.Confidence -ge 0.12) { $pieces.Add($result.Text) }
    }
    @{ text = [string]::Join('', $pieces); engine = 'windows-zh-CN' } | ConvertTo-Json -Compress
} catch {
    if ($Diagnostics) { [Console]::Error.WriteLine($_.Exception.ToString()) }
    [Console]::Error.WriteLine('Local Chinese speech recognition could not complete.')
    exit 1
} finally {
    if ($recognizer) { $recognizer.Dispose() }
}
