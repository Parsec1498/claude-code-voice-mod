# Режими слухача на синтезованих фразах (англ. TTS; мова en: активатор claude, стоп done).
$ErrorActionPreference = 'Stop'
$py = "$env:USERPROFILE\.claude\voice-mod\venv\Scripts\python.exe"
$script = if ($env:LSCRIPT) { $env:LSCRIPT } else { (Join-Path $PSScriptRoot '..\listener\listener.py') }
$h = Join-Path $env:TEMP 'voice-dev\mhome'
New-Item -ItemType Directory -Force $h | Out-Null
$env:HF_HOME = "$env:USERPROFILE\.claude\voice-mod\hf"; $env:HF_HUB_OFFLINE = '1'; $env:PYTHONIOENCODING = 'utf-8'
Add-Type -AssemblyName System.Speech
function wav($name, $ssml) {
  $sp = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $sp.SetOutputToWaveFile("$h\$name.wav", $fmt)
  $sp.SpeakSsml("<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><break time='1000ms'/>$ssml</speak>")
  $sp.Dispose()
}
wav 'one' 'Claude, start the bot and run the login task.'
wav 'multi' "Claude, start the bot.<break time='2500ms'/>Then pause it for a while. Done."
wav 'nostop' "Claude, start the bot.<break time='2500ms'/>Then pause it."
wav 'cancel' "Claude, start the bot.<break time='2500ms'/>Then pause it. Cancel."
wav 'cancelauto' 'Claude, start the bot, cancel.'
wav 'barecancel' "Claude, start the bot.<break time='2500ms'/>Cancel."
wav 'cancelmid' "Claude, start the bot.<break time='2500ms'/>Then pause it for a while, cancel."
wav 'donecancel' "Claude, start the bot.<break time='2500ms'/>Then pause it for a while, done, cancel."
wav 'noise' 'The weather is nice today, let us go for a walk.'
function run($file, $control) {
  [IO.File]::WriteAllText("$h\control.json", $control)
  Remove-Item "$h\bus.json" -ErrorAction SilentlyContinue
  $out = & $py -u $script --home $h --file "$h\$file.wav" --no-beep 2>$null
  $out | Where-Object { $_ -match '"t": "(command|ignored|wake|part|cancelled)"' } | ForEach-Object { "   $_" }
}
"A) автозавершення, одна фраза:"; run 'one' '{"language":"en","autoEnd":true,"beep":"end"}'
"B) без автозавершення, дві фрази + done:"; run 'multi' '{"language":"en","autoEnd":false,"stop":"done","beep":"end"}'
"C) без автозавершення, без done (команди не має бути):"; run 'nostop' '{"language":"en","autoEnd":false,"stop":"done","beep":"end"}'
"D) сигнал одразу (wake): ранній активатор:"; run 'one' '{"language":"en","autoEnd":true,"beep":"wake"}'
"E) сторонні слова:"; run 'noise' '{"language":"en","autoEnd":true,"beep":"wake"}'
"F) без автозавершення, стоп типовий для мови (done):"; run 'multi' '{"language":"en","autoEnd":false,"beep":"end"}'
"G) без автозавершення, «Cancel.» в кінці другої фрази (cancelled, БЕЗ command):"; run 'cancel' '{"language":"en","autoEnd":false,"beep":"end"}'
"H) з автозавершенням, «cancel» у кінці команди (cancelled, БЕЗ command):"; run 'cancelauto' '{"language":"en","autoEnd":true,"beep":"end"}'
"I) без автозавершення, голе «Cancel.» окремою фразою (part, cancelled, БЕЗ command):"; run 'barecancel' '{"language":"en","autoEnd":false,"beep":"end"}'
"J) без автозавершення, «cancel» у кінці довгої (не голої) фрази — через велику модель:"; run 'cancelmid' '{"language":"en","autoEnd":false,"beep":"end"}'
"K) без автозавершення, «…done, cancel.» однією фразою — скасування сильніше за стоп (cancelled, БЕЗ command):"; run 'donecancel' '{"language":"en","autoEnd":false,"beep":"end"}'
# Кнопка скасування: слухач у файловому режимі читає все одразу, тож «натиск» (cancelAt у control.json)
# пишемо, щойно в stdout з'явилась подія $after, — поки слухач ще розпізнає/збирає цю команду.
function tailText($f) {
  try { $fs = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite'); $sr = New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8); $t = $sr.ReadToEnd(); $sr.Close(); $t } catch { '' }
}
function runPress($file, $control, $after) {
  [IO.File]::WriteAllText("$h\control.json", $control)
  Remove-Item "$h\bus.json", "$h\press.out" -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $py -ArgumentList @('-u', "`"$script`"", '--home', "`"$h`"", '--file', "`"$h\$file.wav`"", '--no-beep') `
    -RedirectStandardOutput "$h\press.out" -RedirectStandardError "$h\press.err" -PassThru -WindowStyle Hidden
  while (-not $p.HasExited) {
    if ((tailText "$h\press.out") -match $after) {
      $ms = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
      [IO.File]::WriteAllText("$h\control.json", $control.TrimEnd('}') + ',"cancelAt":' + $ms + '}')
      break
    }
    Start-Sleep -Milliseconds 15
  }
  $p.WaitForExit()
  (tailText "$h\press.out") -split "`r?`n" | Where-Object { $_ -match '"t": "(command|ignored|wake|part|cancelled)"' } | ForEach-Object { "   $_" }
}
"L) з автозавершенням, кнопка ✖ одразу після раннього активатора (cancelled, БЕЗ command):"; runPress 'one' '{"language":"en","autoEnd":true,"beep":"end"}' '"t": "wake"'
"M) без автозавершення, кнопка ✖ після першої фрази диктовки (cancelled, БЕЗ command, хоч «Done» сказано):"; runPress 'multi' '{"language":"en","autoEnd":false,"beep":"end"}' '"t": "part"'
