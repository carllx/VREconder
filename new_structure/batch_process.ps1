# 批量处理VR视频文件 - PowerShell脚本
param(
    [Parameter(Mandatory=$true)]
    [string]$InputDir,
    
    [Parameter(Mandatory=$true)]
    [string]$OutputDir,
    
    [int]$SegmentDuration = 300,
    [string]$Encoder = "libx265",
    [string]$Quality = "high",
    [int]$MaxWorkers = 2,
    [int]$ParallelFiles = 1
)

# 设置工作目录
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "批量处理VR视频文件" -ForegroundColor Green
Write-Host "输入目录: $InputDir" -ForegroundColor Yellow
Write-Host "输出目录: $OutputDir" -ForegroundColor Yellow
Write-Host "编码器: $Encoder" -ForegroundColor Yellow
Write-Host "质量: $Quality" -ForegroundColor Yellow
Write-Host "分割时长: ${SegmentDuration}秒" -ForegroundColor Yellow
Write-Host "每个文件并发数: $MaxWorkers" -ForegroundColor Yellow
Write-Host "文件并行数: $ParallelFiles" -ForegroundColor Yellow
Write-Host ("=" * 80) -ForegroundColor Cyan

# 确保输出目录存在
if (!(Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

# 获取所有MP4文件
$mp4Files = Get-ChildItem -Path $InputDir -Filter "*.mp4" | Sort-Object Name

if ($mp4Files.Count -eq 0) {
    Write-Host "在目录 $InputDir 中未找到MP4文件" -ForegroundColor Red
    exit 1
}

Write-Host "找到 $($mp4Files.Count) 个MP4文件:" -ForegroundColor Green
foreach ($file in $mp4Files) {
    Write-Host "  - $($file.Name)" -ForegroundColor White
}
Write-Host ""

# 处理函数
function Process-SingleFile {
    param($InputFile, $OutputDir, $SegmentDuration, $Encoder, $Quality, $MaxWorkers)
    
    $outputFile = Join-Path $OutputDir "$($InputFile.BaseName)_final_$Encoder.mp4"
    
    $cmd = @(
        "python", "src/main.py", "split-encode-merge",
        "--input-file", $InputFile.FullName,
        "--output-file", $outputFile,
        "--segment-duration", $SegmentDuration,
        "--encoder", $Encoder,
        "--quality", $Quality,
        "--max-workers", $MaxWorkers
    )
    
    Write-Host "开始处理: $($InputFile.Name)" -ForegroundColor Cyan
    Write-Host "输出文件: $(Split-Path $outputFile -Leaf)" -ForegroundColor Cyan
    Write-Host "命令: $($cmd -join ' ')" -ForegroundColor Gray
    Write-Host ("-" * 80) -ForegroundColor Gray
    
    try {
        $result = & $cmd[0] $cmd[1..($cmd.Length-1)] 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ 处理完成: $($InputFile.Name)" -ForegroundColor Green
            return $true
        } else {
            Write-Host "❌ 处理失败: $($InputFile.Name)" -ForegroundColor Red
            Write-Host "错误信息: $result" -ForegroundColor Red
            return $false
        }
    } catch {
        Write-Host "❌ 处理异常: $($InputFile.Name)" -ForegroundColor Red
        Write-Host "异常信息: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

# 批量处理
$successCount = 0

if ($ParallelFiles -eq 1) {
    # 串行处理
    foreach ($file in $mp4Files) {
        $success = Process-SingleFile -InputFile $file -OutputDir $OutputDir -SegmentDuration $SegmentDuration -Encoder $Encoder -Quality $Quality -MaxWorkers $MaxWorkers
        if ($success) { $successCount++ }
        Write-Host ""
    }
} else {
    # 并行处理
    Write-Host "并行处理 $($mp4Files.Count) 个文件 (并行数: $ParallelFiles)" -ForegroundColor Green
    
    $jobs = @()
    foreach ($file in $mp4Files) {
        $job = Start-Job -ScriptBlock {
            param($InputFile, $OutputDir, $SegmentDuration, $Encoder, $Quality, $MaxWorkers, $ScriptDir)
            
            Set-Location $ScriptDir
            $cmd = @(
                "python", "src/main.py", "split-encode-merge",
                "--input-file", $InputFile,
                "--output-file", (Join-Path $OutputDir "$([System.IO.Path]::GetFileNameWithoutExtension($InputFile))_final_$Encoder.mp4"),
                "--segment-duration", $SegmentDuration,
                "--encoder", $Encoder,
                "--quality", $Quality,
                "--max-workers", $MaxWorkers
            )
            
            & $cmd[0] $cmd[1..($cmd.Length-1)] 2>&1
            return $LASTEXITCODE -eq 0
        } -ArgumentList $file.FullName, $OutputDir, $SegmentDuration, $Encoder, $Quality, $MaxWorkers, $ScriptDir
        
        $jobs += $job
        
        # 控制并发数
        while ((Get-Job -State Running).Count -ge $ParallelFiles) {
            Start-Sleep -Seconds 1
        }
    }
    
    # 等待所有任务完成
    $jobs | Wait-Job | Out-Null
    
    # 获取结果
    foreach ($job in $jobs) {
        $result = Receive-Job -Job $job
        if ($result) { $successCount++ }
        Remove-Job -Job $job
    }
}

Write-Host "批量处理完成: $successCount/$($mp4Files.Count) 个文件处理成功" -ForegroundColor Green 