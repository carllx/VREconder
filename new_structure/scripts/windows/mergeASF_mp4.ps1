# 利用 ffmpeg 批量将指定文件夹内的所有 ASF 文件按文件名顺序合并为一个 MP4 文件。
# 合并策略: 先将所有 ASF 转换为临时的 .ts 文件 (尝试流复制以提高效率)，然后使用 concat demuxer 合并。

<#
.SYNOPSIS
    将指定文件夹内的 ASF 文件按文件名顺序合并为一个 MP4 文件。

.DESCRIPTION
    该脚本通过 ffmpeg 工具，遍历用户指定的输入文件夹 (InputPath) 中的所有 .asf 文件。
    这些 ASF 文件将首先被转换为临时的 .ts (MPEG Transport Stream) 文件。
    在转换为 .ts 时，脚本会尝试使用流复制 (-c copy) 以最大化效率。
    然后，所有临时的 .ts 文件将按照原始 ASF 文件的名称顺序通过 ffmpeg 的 concat demuxer 合并成一个单一的 MP4 文件。
    最终的 MP4 文件将保存在用户指定的输出文件路径 (OutputFilePath)。
    脚本会自动处理临时文件的创建和清理。

.PARAMETER InputPath
    必需参数。指定包含源 ASF 文件的文件夹路径。

.PARAMETER OutputFilePath
    必需参数。指定合并后的 MP4 文件的完整输出路径 (包括文件名)。

.EXAMPLE
    PS C:\> ./mergeASF_mp4.ps1 -InputPath "E:\records" -OutputFilePath "E:\merged.mp4"

.NOTES
    作者: Trae AI
    依赖: ffmpeg
#>

param (
    [Parameter(Mandatory=$true)]
    [ValidateScript({Test-Path $_ -PathType Container})]
    [string]$InputPath,

    [Parameter(Mandatory=$true)]
    [string]$OutputFilePath
)

$ffmpegPath = "ffmpeg"
$tempDir = Join-Path $InputPath "temp_merge_files_$(Get-Date -Format 'yyyyMMddHHmmss')"

# 创建临时目录
if (-not (Test-Path $tempDir -PathType Container)) { # Line ~47 in this version
    try {
        New-Item -ItemType Directory -Path $tempDir -ErrorAction Stop | Out-Null
        Write-Host "临时目录 '$tempDir' 创建成功。" -ForegroundColor Green
    } catch {
        Write-Error "无法创建临时目录 '$tempDir'。错误: $($_.Exception.Message)"
        exit 1
    }
} # Closes: if (-not (Test-Path $tempDir -PathType Container))

# $asfFiles = Get-ChildItem -Path $InputPath -Filter *.asf -File | Sort-Object Name
# 修改排序逻辑以正确处理时间
$asfFiles = Get-ChildItem -Path $InputPath -Filter *.asf -File | Sort-Object {
    if ($_.Name -match '(\d{4}\./d{1,2}\./d{1,2}\s\d{1,2}\./d{1,2}\./d{1,2})') {
        try {
            # 解析 "YYYY.M.D H.M.S" 格式
            $dateTimeString = $Matches[1] -replace '\.', '/' # 将点替换为斜杠以适应 ParseExact
            # PowerShell 的 ParseExact 对分隔符敏感，文件名中的点需要处理
            # 例如 "2025.5.29 8.7.4" -> "2025/5/29 8/7/4"
            # 为了更精确匹配，我们尝试几种可能的日期时间格式
            $formats = @(
                "yyyy/M/d H/m/s", 
                "yyyy/MM/dd HH/mm/ss",
                "yyyy/M/d HH/mm/ss",
                "yyyy/MM/dd H/m/s"
            )
            $parsedDate = $null
            foreach ($format in $formats) {
                try {
                    $parsedDate = [datetime]::ParseExact($dateTimeString, $format, $null)
                    if ($parsedDate) { break }
                } catch {}
            }
            if (-not $parsedDate) {
                 # 如果特定格式解析失败，尝试通用解析，但这可能不准确
                 $parsedDate = [datetime]$Matches[1] 
            }
            $parsedDate
        } catch {
            Write-Warning "无法从文件名 '$($_.Name)' 解析日期时间，将使用原始名称排序。"
            $_.Name # 解析失败则按原名排序
        }
    } else {
        $_.Name # 不匹配格式则按原名排序
    }
}

if ($asfFiles.Count -eq 0) {
    Write-Warning "在 '$InputPath' 中没有找到任何 .asf 文件。"
    if (Test-Path $tempDir -PathType Container) { Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
    exit 0
}

Write-Host "找到 $($asfFiles.Count) 个 ASF 文件，开始预处理为 .ts 文件..." -ForegroundColor Cyan
$tsFilesListPath = Join-Path $tempDir "filelist.txt"
$tsFilePaths = @()

# 转换每个 ASF 到 TS
foreach ($file in $asfFiles) { # Line ~67 in this version
    $inputFilePath = $file.FullName
    $tempTsFileName = "temp_" + [System.IO.Path]::ChangeExtension($file.Name, ".ts")
    $tempTsFilePath = Join-Path $tempDir $tempTsFileName
    Write-Host "`n正在转换: $($file.Name) -> $tempTsFileName" -ForegroundColor White
    
    # 修改 ffmpeg 参数以重新编码视频为 H.264，并复制音频
    $ffmpegConvertArgs = "-i `"$inputFilePath`" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k -f mpegts -avoid_negative_ts make_non_negative -y `"$tempTsFilePath`""
    try { 
        Write-Host "执行 ffmpeg 转换命令: $ffmpegPath $ffmpegConvertArgs"
        # Start-Process $ffmpegPath -ArgumentList $ffmpegConvertArgs -Wait -NoNewWindow
        Start-Process $ffmpegPath -ArgumentList $ffmpegConvertArgs -Wait -NoNewWindow -RedirectStandardOutput "$tempDir\convert_log.txt" -RedirectStandardError "$tempDir\convert_error.txt"
        # 或者更简单地，但要注意转义：
        # Invoke-Expression "& '$ffmpegPath' $ffmpegConvertArgs 2>&1 | Tee-Object -FilePath '$tempDir\convert_log.txt'"
        
        if (Test-Path $tempTsFilePath) {
            Write-Host "转换到 .ts 成功: $tempTsFilePath" -ForegroundColor Green
            "file '$([System.IO.Path]::GetFullPath($tempTsFilePath).Replace('\', '/'))'" | Add-Content -Path $tsFilesListPath
            $tsFilePaths += $tempTsFilePath
        } else {
            Write-Error "转换为 .ts 失败，输出文件未生成: $tempTsFilePath"
        }
    } catch {
        Write-Error "ffmpeg 转换过程中发生错误: $($_.Exception.Message)"
        Write-Error "处理文件 '$($file.Name)' 失败。"
    }
} 

if ($tsFilePaths.Count -eq 0) {
    Write-Error "没有成功的 .ts 文件生成，无法合并。"
    if (Test-Path $tempDir -PathType Container) { Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
    exit 1
}

Write-Host "`n所有 ASF 文件已转换为 .ts，准备合并..." -ForegroundColor Cyan
Write-Host "合并列表文件: $tsFilesListPath"

$ffmpegMergeArgs = "-f concat -safe 0 -i `"$tsFilesListPath`" -c:v copy -c:a copy -y `"$OutputFilePath`""

# 合并 TS 文件
Write-Host "执行 ffmpeg 合并命令: $ffmpegPath $ffmpegMergeArgs"
try {
    Start-Process $ffmpegPath -ArgumentList $ffmpegMergeArgs -Wait -NoNewWindow
    if (Test-Path $OutputFilePath) {
        Write-Host "合并成功: $OutputFilePath" -ForegroundColor Green
    } else {
        Write-Error "合并失败，输出文件未生成: $OutputFilePath"
    }
} catch {
    Write-Error "ffmpeg 合并过程中发生错误: $($_.Exception.Message)"
}

# 清理
Write-Host "`n正在清理临时文件..." -ForegroundColor Yellow
if (Test-Path $tempDir -PathType Container) { Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host "清理完成。"

Write-Host "`n所有操作完成。" -ForegroundColor Cyan