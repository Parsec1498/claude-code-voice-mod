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
