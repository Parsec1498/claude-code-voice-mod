# Живий прогін нових механік слухача на окремій теці (не чіпає ~/.claude/voice-mod).
$ErrorActionPreference = 'Stop'
$py = "$env:USERPROFILE\.claude\voice-mod\venv\Scripts\python.exe"
$script = (Join-Path $PSScriptRoot '..\listener\listener.py')
$h = Join-Path $env:TEMP 'voice-dev\lhome'
Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $h | Out-Null
$env:HF_HOME = "$env:USERPROFILE\.claude\voice-mod\hf"; $env:HF_HUB_OFFLINE = '1'
function put($f, $t) { [IO.File]::WriteAllText((Join-Path $h $f), $t) }
function ms { [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) }
function bus { try { [IO.File]::ReadAllText("$h\bus.json", [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $null } }
function waitFor($cond, $sec, $what) {
  $t = 0; while ($t -lt $sec) { if (& $cond) { "OK  $what (${t}s)"; return }; Start-Sleep 1; $t++ }
  "FAIL $what after ${sec}s; state=$((bus).state) last=$(((bus).events | Select-Object -Last 1).text)"
}
function lastInfo { ((bus).events | Where-Object kind -eq 'info' | Select-Object -Last 1).text }
function alive { (Get-Item "$h\alive-test.json").LastWriteTime = Get-Date }

put "control.json" '{"muted":true}'
put "alive-test.json" '{}'
# Мережа для докачки моделей — недосяжна: перевіряємо шлях помилки, нічого не качаючи.
$env:HF_ENDPOINT = 'http://127.0.0.1:9'
& $py -u $script --home $h --mutex LocalClaudeVoiceListenerTest --detach --muted-exit 30 --orphan-after 25 | Out-Host
Remove-Item Env:HF_ENDPOINT
waitFor { (lastInfo) -match 'без моделей' } 30 'старт при вимкненому мікрофоні — без моделей'
$pid1 = (bus).pid
"listener pid=$pid1, alive=$([bool](Get-Process -Id $pid1 -ErrorAction SilentlyContinue))"

(Get-Item "$h\alive-test.json").LastWriteTime = Get-Date
put "control.json" '{"muted":false}'
waitFor { (lastInfo) -match 'моделі готові' } 90 "увімкнули мікрофон — моделі вантажаться: $(lastInfo)"
"info: $(lastInfo)"
"bus device=$((bus).device) models=$(((bus).models) -join ',')"

alive
put "control.json" '{"muted":false,"wakeModel":"base","model":"small"}'
waitFor { alive; (lastInfo) -match 'base\+small' } 90 "вибрали base+small — моделі підмінено: $(lastInfo)"
if ((bus).pid -eq $pid1) { "OK  підміна в тому ж процесі (pid $pid1)" } else { "FAIL підміна: pid $((bus).pid), а був $pid1" }
"info: $(lastInfo)"

put "control.json" '{"muted":false,"wakeModel":"base","model":"large-v2"}'
waitFor { alive; (bus).state -eq 'error' } 60 'large-v2 нема на диску, мережі нема — стан error'
"error: $(((bus).events | Where-Object kind -eq 'error' | Select-Object -Last 1).text)"
waitFor { alive; (bus).state -eq 'ready' } 30 'після невдалої докачки — знову ready старими моделями'
if ((bus).pid -eq $pid1) { "OK  той самий процес після помилки (pid $pid1)" } else { "FAIL pid $((bus).pid), а був $pid1" }

alive
put "control.json" ('{"muted":true,"restart":' + (ms) + '}')
waitFor { -not (Get-Process -Id $pid1 -ErrorAction SilentlyContinue) } 15 'restart у control.json — слухач вийшов'
"bus state=$((bus).state) msg=$((bus).msg)"

put "control.json" '{"muted":true}'
(Get-Item "$h\alive-test.json").LastWriteTime = Get-Date
& $py -u $script --home $h --mutex LocalClaudeVoiceListenerTest --detach --muted-exit 3 --orphan-after 25 | Out-Host
waitFor { (bus).pid -and (bus).pid -ne $pid1 } 15 'новий слухач піднявся'
$pid3 = (bus).pid
waitFor { -not (Get-Process -Id $pid3 -ErrorAction SilentlyContinue) } 20 'мікрофон вимкнено 3 с — слухач вийшов сам'
"info: $(lastInfo)"

& $py -u $script --home $h --mutex LocalClaudeVoiceListenerTest --detach --orphan-after 5 | Out-Host
Start-Sleep 4
$pid2 = (bus).pid
(Get-Item "$h\alive-test.json").LastWriteTime = (Get-Date).AddMinutes(-5)
waitFor { -not (Get-Process -Id $pid2 -ErrorAction SilentlyContinue) } 40 'жодної живої сесії — слухач вийшов сам'
"bus state=$((bus).state) msg=$((bus).msg)"

# Вибрана модель є на диску, але не вантажиться -> помилка й типові на ТОМУ Ж
# пристрої (не CPU з тією ж моделлю). Кеш HF — окремий: справжні моделі
# підключені junction-ами, «medium» — підробка з битим model.bin.
$real = "$env:USERPROFILE\.claude\voice-mod\hf\hub"
$fake = Join-Path $env:TEMP 'voice-dev\fakehub'
function dropFake {
  # НЕ Remove-Item -Recurse: у PowerShell 5.1 він іде всередину junction і
  # стер би справжні моделі. cmd rmdir /s прибирає junction як посилання,
  # не заходячи в ціль (перевірено на манекені).
  if (Test-Path $fake) { cmd /c rmdir /s /q "$fake" }
  if (Test-Path $fake) { throw "fakehub не прибрано: $fake" }
}
$out = ''
try {
  dropFake
  New-Item -ItemType Directory -Force $fake | Out-Null
  foreach ($d in 'blobs', 'models--Systran--faster-whisper-small', 'models--Systran--faster-whisper-large-v3') {
    New-Item -ItemType Junction -Path (Join-Path $fake $d) -Target (Join-Path $real $d) | Out-Null
  }
  $rev = '0' * 40
  $snap = Join-Path $fake "models--Systran--faster-whisper-medium\snapshots\$rev"
  New-Item -ItemType Directory -Force $snap, (Join-Path $fake 'models--Systran--faster-whisper-medium\refs') | Out-Null
  [IO.File]::WriteAllText((Join-Path $fake 'models--Systran--faster-whisper-medium\refs\main'), $rev)
  foreach ($f in 'model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt') { [IO.File]::WriteAllText((Join-Path $snap $f), 'broken') }
  $h2 = Join-Path $env:TEMP 'voice-dev\lhome-bad'
  Remove-Item -Recurse -Force $h2 -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $h2 | Out-Null
  [IO.File]::WriteAllText((Join-Path $h2 'control.json'), '{"muted":false,"model":"medium"}')
  $wav = Join-Path $h2 'silence.wav'
  & $py -c "import sys, wave; w = wave.open(sys.argv[1], 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(bytes(32000)); w.close()" $wav
  $env:HF_HUB_CACHE = $fake; $env:PYTHONIOENCODING = 'utf-8'
  $out = (& $py -u $script --home $h2 --file $wav --no-beep 2>$null) -join "`n"
} finally {
  Remove-Item Env:HF_HUB_CACHE -ErrorAction SilentlyContinue
  dropFake
}
if ($out -match 'state": "error".*small\+medium[^\n]*cuda') { "OK  битий medium — стан error з причиною" } else { "FAIL нема помилки про small+medium:`n$out" }
if ($out -match 'моделі готові[^\n]*small\+large-v3 на cuda') { "OK  після помилки — типові на тому ж пристрої (cuda)" } else { "FAIL типові не на cuda:`n$out" }
if ($out -notmatch 'cuda не піднялась') { "OK  без переходу на CPU" } else { "FAIL перейшов на CPU:`n$out" }
(($out -split "`n") | Select-String 'error|готові') -join "`n"

# ---------------------------------------------------------------- озвучення (Piper)
# Окрема тека, мова en, справжній мікрофон і динаміки. Перше справжнє встановлення
# (Piper з PyPI + голос з HF, хвилини) кладе готовий tts\ у кеш; наступні прогони копіюють
# його і проганяють той самий ttsInstall уже без докачки (pip: «already satisfied»).
$h = Join-Path $env:TEMP 'voice-dev\thome'
$cache = Join-Path $env:TEMP 'voice-dev\tts-cache'
Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $h | Out-Null
$joe = 'en_US-joe-medium'
$base = '"muted":false,"language":"en","speak":true,"wakeModel":"small","model":"small"'
function ctl($extra) { put "control.json" ('{' + $base + $extra + '}') }
function say($text, $at = 0, $voice = $joe) {
  if (-not $at) { $at = ms }
  put "speak.json" (@{ seq = $at; at = $at; text = $text; lang = 'en'; voice = $voice; session = 'test' } | ConvertTo-Json -Compress)
}
function lastSeq { [int64]((bus).seq) }
# Виклики — у @(...): PowerShell 5.1 розгортає масив з одного PSCustomObject, а в нього нема .Count.
function eventsAfter($seq, $kinds) { @((bus).events | Where-Object { $_.seq -gt $seq -and $kinds -contains $_.kind }) }
function piperProcs { @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('-m piper') -and $_.CommandLine.Contains($h) }) }
function untilState($name, $sec) {
  $t = Get-Date
  while (((Get-Date) - $t).TotalSeconds -lt $sec) { if ((bus).state -eq $name) { return ((Get-Date) - $t).TotalSeconds }; Start-Sleep -Milliseconds 100 }
  return $null
}
$long = 'This is a check of the speech output. The listener must stay deaf while this voice is playing, so nothing it says can turn into a command. It keeps talking for a while, sentence after sentence, to leave enough time for the test to speak over it. Almost finished now. That is all for this check.'

$hadCache = Test-Path "$cache\installed.json"
if ($hadCache) { robocopy $cache "$h\tts" /E /NFL /NDL /NJH /NJS /NP | Out-Null; "tts з кешу: $cache" }
ctl ''
put "alive-test.json" '{}'
& $py -u $script --home $h --mutex LocalClaudeVoiceListenerTest --detach --muted-exit 30 --orphan-after 900 | Out-Host
waitFor { alive; (bus).state -eq 'ready' } 120 'озвучення: слухач готовий (en, small+small)'
$tpid = (bus).pid
"bus tts=$((bus).tts) voices=$(((bus).voices) -join ',')"

ctl (',"ttsInstall":' + (ms))
waitFor { alive; (bus).tts -eq 'installing' } 15 'ttsInstall — bus.tts installing'
waitFor { alive; (bus).tts -ne 'installing' } 600 'встановлення скінчилось'
if ((bus).tts -eq 'ready') { "OK  bus.tts ready" } else {
  "FAIL bus.tts=$((bus).tts): $(((bus).events | Where-Object kind -eq 'error' | Select-Object -Last 1).text)"
  Get-Content "$h\tts.log" -Tail 10
  put "control.json" ('{"muted":true,"restart":' + (ms) + '}')
  return
}
if (@((bus).voices) -contains $joe) { "OK  голос $joe у bus.voices" } else { "FAIL bus.voices=$(((bus).voices) -join ',')" }
if (-not $hadCache) { robocopy "$h\tts" $cache /E /NFL /NDL /NJH /NJS /NP | Out-Null; "tts закешовано: $cache" }

# speak.json → speaking → ready; поки звучить, SAPI вголос каже фразу з активатором.
$s0 = lastSeq
say $long
waitFor { alive; (bus).state -eq 'speaking' } 15 'speak.json — стан speaking'
$sp = @(eventsAfter $s0 'spoke')
if ($sp.Count -eq 1) { "OK  подія spoke: $($sp[0].text.Substring(0, 30))…" } else { "FAIL подій spoke: $($sp.Count)" }
if (@(piperProcs).Count -gt 0) { "OK  Piper — окремий процес (-m piper)" } else { "FAIL процесу -m piper не видно" }
# Живий слухач власника, що слухає мікрофон, почув би «Claude, …» і відправив би це в чат.
$live = try { [IO.File]::ReadAllText("$env:USERPROFILE\.claude\voice-mod\bus.json", [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $null }
$liveOn = $live -and ($live.state -notin 'off', 'muted') -and (Get-Process -Id $live.pid -ErrorAction SilentlyContinue)
$phrase = 'Claude, run the tests. Done.'
if ($liveOn) {
  "SKIP SAPI вголос: живий слухач власника слухає мікрофон (state=$($live.state))"
  waitFor { alive; (bus).state -eq 'ready' } 60 'озвучка скінчилась — ready'
} else {
  Add-Type -AssemblyName System.Speech
  $sapi = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s1 = lastSeq
  $sapi.Speak($phrase)
  $during = (bus).state
  if ($during -eq 'speaking') { "OK  SAPI сказав «$phrase», поки звучить Piper" } else { "FAIL Piper замовк раніше за SAPI: стан $during" }
  waitFor { alive; (bus).state -eq 'ready' } 60 'озвучка скінчилась — ready'
  Start-Sleep 2
  # Глухий — нічого не почуто взагалі: ні команди, ні стороннього, ні частини диктовки.
  $heard = @(eventsAfter $s1 'command', 'ignored', 'part')
  if ($heard.Count -eq 0) { "OK  під час speaking у bus.json нічого не почуто (ні command, ні ignored)" } else { "FAIL почуто під час озвучки: $(($heard | ForEach-Object { "$($_.kind): $($_.text)" }) -join ' | ')" }
  # Контроль: та сама фраза вже без озвучки. Стала командою — мікрофон чує динаміки, і
  # перевірка вище показова; ні — мікрофон динаміків не чує, і вона нічого не довела.
  $s2 = lastSeq
  $sapi.Speak($phrase)
  $t = 0; while ($t -lt 15 -and @(eventsAfter $s2 'command').Count -eq 0) { Start-Sleep 1; $t++ }
  $ctl = @(eventsAfter $s2 'command', 'ignored', 'part')
  if ($ctl.Count -gt 0) { "OK  контроль: без озвучки та сама фраза почута (мікрофон чує динаміки): $(($ctl | ForEach-Object { "$($_.kind): $($_.text)" }) -join ' | ')" }
  else { "INFO контроль: без озвучки фразу не почуто — мікрофон не чує динаміків, перевірка глухоти непоказова" }
  $sapi.Dispose()
}

# ✖ під час озвучки — ready менш ніж за 2 с, Piper зупинено.
say $long
waitFor { alive; (bus).state -eq 'speaking' } 15 'новий блок — speaking'
Start-Sleep 2
ctl (',"cancelAt":' + (ms))
$dt = untilState 'ready' 5
if ($null -ne $dt -and $dt -lt 2) { "OK  ✖ під час speaking — ready за $([math]::Round($dt, 2)) с" } else { "FAIL ✖ під час speaking: стан $((bus).state) за $dt" }
Start-Sleep 1
if (@(piperProcs).Count -eq 0) { "OK  після ✖ процесу Piper нема" } else { "FAIL після ✖ Piper живий" }

# Мікрофон вимкнули під час озвучки — звук обірвано, стан muted.
ctl ''
say $long
waitFor { alive; (bus).state -eq 'speaking' } 15 'ще блок — speaking'
Start-Sleep 2
put "control.json" ('{' + ($base -replace '"muted":false', '"muted":true') + '}')
$dt = untilState 'muted' 5
if ($null -ne $dt) { "OK  muted під час speaking — стан muted за $([math]::Round($dt, 2)) с" } else { "FAIL muted: стан $((bus).state)" }
Start-Sleep 1
if (@(piperProcs).Count -eq 0) { "OK  звук обірвано: процесу Piper нема" } else { "FAIL після muted Piper живий" }
ctl ''
waitFor { alive; (bus).state -eq 'ready' } 30 'мікрофон увімкнули — ready'

# speak.json зі старим at (70 с) — не звучить.
$s0 = lastSeq
say $long ((ms) - 70000)
Start-Sleep 4
if ((bus).state -ne 'speaking' -and @(eventsAfter $s0 'spoke').Count -eq 0) { "OK  старий at — не звучить" } else { "FAIL старий at озвучено" }

# ↻ слухача при свіжому speak.json — новий слухач його вдруге не озвучує.
say $long
waitFor { alive; (bus).state -eq 'speaking' } 15 'блок перед ↻ — speaking'
ctl (',"restart":' + (ms))
waitFor { -not (Get-Process -Id $tpid -ErrorAction SilentlyContinue) } 15 '↻ — слухач вийшов'
if (@(piperProcs).Count -eq 0) { "OK  після виходу слухача Piper не лишився" } else { "FAIL Piper пережив слухача" }
ctl ''
alive
& $py -u $script --home $h --mutex LocalClaudeVoiceListenerTest --detach --muted-exit 30 --orphan-after 900 | Out-Host
waitFor { alive; (bus).pid -ne $tpid -and (bus).state -eq 'ready' } 120 'новий слухач готовий'
$tpid = (bus).pid
$s0 = lastSeq
Start-Sleep 5
if ((bus).state -ne 'speaking' -and @(eventsAfter $s0 'spoke').Count -eq 0) { "OK  ↻ при свіжому speak.json — вдруге не звучить" } else { "FAIL після ↻ блок озвучено вдруге" }

# Битий .onnx — стан error з причиною, потім знову ready.
$bad = 'en_US-kristin-medium'
Copy-Item "$h\tts\voices\$joe.onnx.json" "$h\tts\voices\$bad.onnx.json"
[IO.File]::WriteAllText("$h\tts\voices\$bad.onnx", 'broken')
say 'This voice file is broken.' 0 $bad
waitFor { alive; (bus).state -eq 'error' } 30 'битий .onnx — стан error'
"error: $(((bus).events | Where-Object kind -eq 'error' | Select-Object -Last 1).text)"
waitFor { alive; (bus).state -eq 'ready' } 15 'після помилки — знову ready'

# Видалення: tts\ стерто, bus.tts absent.
ctl (',"ttsRemove":' + (ms))
waitFor { alive; -not (Test-Path "$h\tts") -and (bus).tts -eq 'absent' } 30 'ttsRemove — tts\ стерто, bus.tts absent'
"bus voices=$(((bus).voices) -join ',')"
put "control.json" ('{"muted":true,"restart":' + (ms) + '}')
waitFor { -not (Get-Process -Id $tpid -ErrorAction SilentlyContinue) } 15 'кінець — слухач вийшов'
