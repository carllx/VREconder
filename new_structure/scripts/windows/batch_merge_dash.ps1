[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

<#
.SYNOPSIS
批量处理子文件夹中的视频合并任务

.DESCRIPTION
在指定根目录下递归执行 MergeDash.ps1 处理所有包含视频文件的子文件夹

.PARAMETER RootPath
要处理的根目录路径（必需）

.PARAMETER LogPath
日志文件保存路径（默认：当前目录的 merge_logs.csv）

.EXAMPLE
./BatchMergeDash.ps1 -RootPath "/Volumes/Media/VR/Videos" -LogPath "/Volumes/Media/VR/logs/merge_results.csv"
#>

param(
    [Parameter(Mandatory=$true)]
    [ValidateScript({Test-Path $_ -PathType Container})]
    [string]$RootPath,
    
    [string]$LogPath = (Join-Path $PSScriptRoot "merge_logs.csv")
)

# 初始化日志系统
$logHeader = "时间戳,文件夹路径,状态,耗时(秒),错误信息"
if (-not (Test-Path $LogPath)) {
    $logHeader | Out-File -FilePath $LogPath -Encoding UTF8
}

# 进度显示配置
$progressParams = @{
    Activity = "视频合并批处理"
    CurrentOperation = "扫描文件夹..."
}

# 获取所有需要处理的文件夹
Write-Host "正在扫描视频文件夹..." -ForegroundColor Cyan
$videoFolders = Get-ChildItem -Path $RootPath -Recurse -Directory | Where-Object {
    (Get-ChildItem $_.FullName -File -Filter *.m4s).Count -gt 0
}
$totalCount = $videoFolders.Count
Write-Host "找到 $totalCount 个包含视频的文件夹`n" -ForegroundColor Green

# 处理统计
$statistics = [PSCustomObject]@{
    Total       = $totalCount
    Success     = 0
    Failed      = 0
    Skipped     = 0
    StartTime   = Get-Date
}

# 主处理循环
foreach ($i in 0..($videoFolders.Count-1)) {
    $folder = $videoFolders[$i]
    $folderPath = $folder.FullName
    $folderName = $folder.Name
    
    $logEntry = [PSCustomObject]@{
        Timestamp  = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Folder     = $folderPath
        Status     = $null
        Duration   = 0
        Error      = $null
    }
    
    # 进度显示
    $progressParams.PercentComplete = ($i / $totalCount * 100)
    $progressParams.Status = "正在处理：$folderName ($($i+1)/$totalCount)"
    Write-Progress @progressParams
    
    try {
        # 跳过已存在输出文件的情况
        $outputFile = Join-Path $folderPath "$folderName.mp4"
        if (Test-Path $outputFile) {
            Write-Host "[跳过] 已存在输出文件：$outputFile" -ForegroundColor Yellow
            $logEntry.Status = "Skipped"
            $statistics.Skipped++
            continue
        }
        
        # 执行合并处理
        $startTime = Get-Date
        Write-Host "`n[$($i+1)/$totalCount] 开始处理：$folderPath" -ForegroundColor Cyan
        
        # 使用 & 调用脚本并捕获输出
        $mergeScript = Join-Path $PSScriptRoot "MergeDash.ps1"
        & $mergeScript $folderPath 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                Write-Host "[错误] $_" -ForegroundColor Red
            } else {
                Write-Host "[日志] $_"
            }
        }
        
        # 结果验证
        if (-not (Test-Path $outputFile)) {
            throw "输出文件未生成"
        }
        
        # 记录成功
        $logEntry.Status = "Success"
        $logEntry.Duration = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 2)
        $statistics.Success++
        Write-Host "[成功] 输出文件生成：$folderName.mp4" -ForegroundColor Green
    } 
    catch {
        # 错误处理
        $logEntry.Status = "Failed"
        $logEntry.Error = $_.Exception.Message
        $statistics.Failed++
        Write-Host "[严重错误] 处理失败：$($_.Exception.Message)" -ForegroundColor Red
    } 
    finally {
        # 写入日志
        $logEntry | Select-Object Timestamp, Folder, Status, Duration, Error |
        Export-Csv -Path $LogPath -Append -Encoding UTF8 -NoTypeInformation
    }
}

# 计算总耗时
$totalDuration = [math]::Round(((Get-Date) - $statistics.StartTime).TotalMinutes, 2)

# 显示统计结果
Write-Host "`n处理完成！统计结果：" -ForegroundColor Cyan
Write-Host "总文件夹数: $($statistics.Total)" -ForegroundColor White
Write-Host "成功处理: $($statistics.Success)" -ForegroundColor Green
Write-Host "处理失败: $($statistics.Failed)" -ForegroundColor Red
Write-Host "已跳过: $($statistics.Skipped)" -ForegroundColor Yellow
Write-Host "总耗时: $totalDuration 分钟" -ForegroundColor White
Write-Host "`n详细日志已保存至：$LogPath`n" -ForegroundColor Green

# 如果有失败的任务，返回非零状态码
if ($statistics.Failed -gt 0) {
    exit 1
}
exit 0


# 1. 基本用法：
# ```powershell
# ./BatchMergeDash.ps1 -RootPath "/Volumes/Media/VR/Videos"
#  ```


# 2. 指定日志路径：
# ```powershell
# ./BatchMergeDash.ps1 -RootPath "/Volumes/Media/VR/Videos" -LogPath "/Volumes/Media/VR/logs/vr_processing_log.csv"
#  ```
[string]$LogPath = (Join-Path $PSScriptRoot "merge_logs.csv")
