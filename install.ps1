# Встановлення слухача голосового мода: venv, бібліотеки, моделі whisper.
# Усе лягає в %USERPROFILE%\.claude\voice-mod — там його шукає мод.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1        # з GPU NVIDIA (CUDA)
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Cpu   # без GPU
#
# Моделі (~5 ГБ): small + large-v3 для GPU і base + large-v3-turbo як запасні для
# CPU. Слухач стартує з HF_HUB_OFFLINE=1, тож потрібні моделі мають бути на диску
# заздалегідь — і запасні теж, інакше відкат на CPU без мережі не підніметься.
param([switch]$Cpu)
$ErrorActionPreference = 'Stop'

$vhome = Join-Path $env:USERPROFILE '.claude\voice-mod'
$venv = Join-Path $vhome 'venv'
$py = Join-Path $venv 'Scripts\python.exe'
New-Item -ItemType Directory -Force $vhome | Out-Null

if (-not (Test-Path $py)) {
  Write-Host "venv -> $venv"
  & py -3 -m venv $venv
  if ($LASTEXITCODE) { throw 'не вдалося створити venv (потрібен Python 3.10+ і лаунчер py)' }
}
& $py -m pip install --upgrade pip --quiet
& $py -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
if (-not $Cpu) {
  # cuBLAS/cuDNN для ctranslate2 колесами pip — CUDA Toolkit у системі не потрібен.
  & $py -m pip install nvidia-cublas-cu12 'nvidia-cudnn-cu12>=9,<10'
}
if ($LASTEXITCODE) { throw 'pip не встановив залежності' }

$env:HF_HOME = Join-Path $vhome 'hf'
$models = if ($Cpu) { "'base', 'large-v3-turbo'" } else { "'small', 'large-v3', 'base', 'large-v3-turbo'" }
Write-Host "моделі -> $env:HF_HOME"
& $py -c "from faster_whisper.utils import download_model; [print(m, '->', download_model(m)) for m in ($models)]"
if ($LASTEXITCODE) { throw 'не вдалося завантажити моделі' }
Write-Host 'Готово. Увімкніть мікрофон у рядку мода над полем вводу.'
