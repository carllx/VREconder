# PowerShell version of MergeDash.sh - Working version with audio stream corruption fixes

#region Functions

function Get-Duration {
    param(
        [string]$Start,
        [string]$End
    )
    $duration = [double]$End - [double]$Start
    return $duration
}

# 优化：改进的二进制文件合并函数
function Merge-BinaryFiles {
    param (
        [string]$TargetFile,
        [string]$SourceFile
    )
    
    try {
        # 检查文件锁定状态
        $maxRetries = 3
        $retryCount = 0
        do {
            try {
                if (Test-Path $TargetFile) {
                    $fileStream = [System.IO.File]::Open($TargetFile, 'Open', 'Read', 'None')
                    $fileStream.Close()
                }
                break
            } catch {
                $retryCount++
                Start-Sleep -Milliseconds 200
            }
        } while ($retryCount -lt $maxRetries)
        
        if ($retryCount -eq $maxRetries) {
            Write-Warning "文件被锁定：$TargetFile"
            return $false
        }
        
        # 创建唯一临时文件
        $tempFile = [System.IO.Path]::Combine(
            [System.IO.Path]::GetTempPath(),
            [System.IO.Path]::GetRandomFileName()
        )
        
        # 检查操作系统类型并执行合并操作
        if ($IsWindows -or $env:OS -match 'Windows') {
            # Windows 系统使用 cmd copy 命令
            if (Test-Path -Path $TargetFile) {
                cmd /c "copy /b `"$TargetFile`" + `"$SourceFile`" `"$tempFile`" > nul"
            } else {
                cmd /c "copy /b `"$SourceFile`" `"$tempFile`" > nul"
            }
        } else {
            # Unix/Linux/MacOS 系统使用 cat 命令
            if (Test-Path -Path $TargetFile) {
                cat "$SourceFile" >> "$tempFile"
            } else {
                cat "$SourceFile" > "$tempFile"
            }
        }
        
        # 原子替换操作
        if (Test-Path $tempFile) {
            Move-Item -Path $tempFile -Destination $TargetFile -Force -ErrorAction Stop
            return $true
        }
        
        return $false
    } catch {
        # 清理残留文件
        if (Test-Path -Path $tempFile) { 
            Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
        }
        Write-Warning "合并失败：$($_.Exception.Message)"
        return $false
    }
}

# 新增：音频流修复函数
function Repair-AudioStream {
    param (
        [string]$InputFile,
        [string]$OutputFile,
        [string]$Duration
    )
    
    $ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Path
    if (!$ffmpeg) {
        Write-Host "错误：未找到 ffmpeg。请安装 ffmpeg 并确保它在 PATH 中。"
        return $false
    }
    
    # 尝试多种修复策略
    $strategies = @()
    $strategies += @{
        Name = "Discard Corrupt Packets"
        Args = @("-y", "-i", $InputFile, "-ss", "0", "-c", "copy", "-fflags", "+discardcorrupt", "-ignore_unknown", "-t", $Duration, $OutputFile)
    }
    $strategies += @{
        Name = "Re-encode Audio"
        Args = @("-y", "-i", $InputFile, "-ss", "0", "-c:v", "copy", "-c:a", "aac", "-avoid_negative_ts", "make_zero", "-fflags", "+discardcorrupt", "-t", $Duration, $OutputFile)
    }
    $strategies += @{
        Name = "Video Only"
        Args = @("-y", "-i", $InputFile, "-ss", "0", "-c:v", "copy", "-an", "-t", $Duration, $OutputFile)
    }
    $strategies += @{
        Name = "Loose Parameters"
        Args = @("-y", "-i", $InputFile, "-ss", "0", "-c:v", "copy", "-c:a", "aac", "-strict", "experimental", "-fflags", "+discardcorrupt+genpts", "-t", $Duration, $OutputFile)
    }
    
    foreach ($strategy in $strategies) {
        Write-Host "尝试策略: $($strategy.Name)"
        Write-Host "执行: ffmpeg $($strategy.Args -join ' ')"
        
        & $ffmpeg @($strategy.Args)
        if ($LASTEXITCODE -eq 0) {
            Write-Host "策略 '$($strategy.Name)' 成功"
            return $true
        } else {
            Write-Host "策略 '$($strategy.Name)' 失败，尝试下一个..."
        }
    }
    
    Write-Host "所有修复策略都失败了"
    return $false
}

# 修改 Cleanup 函数，增加临时文件清理
function Cleanup {
    param(
        [string]$TempDir
    )
    if (Test-Path -Path $TempDir -PathType Container) {
        # Clean up symbolic link directory
        Remove-Item -Path (Join-Path -Path $TempDir -ChildPath "links") -Recurse -Force -ErrorAction SilentlyContinue

        # Clean up other temporary files
        Get-ChildItem -Path $TempDir -File -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
        
        # 清理所有残留的临时文件
        Get-ChildItem -Path $TempDir -Filter *.tmp -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
        
        Remove-Item -Path $TempDir -Force -ErrorAction SilentlyContinue
    }
}

#region Main Script

# Check for command-line arguments
if ($args.Count -eq 0) {
    Write-Host "请提供文件夹路径"
    Write-Host "用法: $($MyInvocation.MyCommand.Name) <文件夹路径>"
    exit 1
}

# Define variables
$folder_dir = $args[0]
$folder_temp = Join-Path -Path $folder_dir -ChildPath "temp"
$dir_concat = Join-Path -Path $folder_temp -ChildPath "concat.txt"

# Check if the folder exists
if (!(Test-Path -Path $folder_dir -PathType Container)) {
    Write-Host "错误：文件夹不存在: $folder_dir"
    exit 1
}

# Create the temp directory
New-Item -Path $folder_temp -ItemType Directory -Force | Out-Null

# Use trap for cleanup on exit or error
$ErrorActionPreference = "Stop"
trap {
    Cleanup -TempDir $folder_temp
    Write-Error $_
    exit 1
}

$init_file = Get-ChildItem -Path $folder_dir -File -Filter "init.mp4"
$start_for_identifier = @{}
$end_for_identifier = @{}
$identifiers = @()

# 优化：预加载所有文件信息
Write-Host "预加载文件信息..."
$allFiles = Get-ChildItem -Path $folder_dir -File
$m4sFiles = $allFiles | Where-Object { $_.Name -match '^P[0-9]+-[0-9.]+-[0-9.]+-[0-9]+\.m4s$' }
Write-Host "找到 $($m4sFiles.Count) 个 m4s 文件"

# Iterate through files in the folder
foreach ($file in $m4sFiles) {
    $filename = $file.Name
    
    # Regex to match floating-point numbers
    if ($filename -match '^P([0-9]+)-([0-9.]+)-([0-9.]+)-[0-9]+\.m4s$') {
        $identifier = $Matches[1]
        $start = $Matches[2]
        $end = $Matches[3]
        
        Write-Host "解析文件: $filename"
        Write-Host "解析结果: identifier=$identifier, start=$start, end=$end"
        
        if ([string]::IsNullOrEmpty($identifier) -or [string]::IsNullOrEmpty($start) -or [string]::IsNullOrEmpty($end)) {
            Write-Host "警告：文件 $filename 解析出的值无效"
        } else {
            if (-not $start_for_identifier.ContainsKey($identifier)) {
                $identifiers += $identifier
            }
            
            if (-not $start_for_identifier.ContainsKey($identifier) -or ([double]$start_for_identifier[$identifier] -gt [double]$start)) {
                $start_for_identifier[$identifier] = $start
            }
            
            if (-not $end_for_identifier.ContainsKey($identifier) -or ([double]$end_for_identifier[$identifier] -lt [double]$end)) {
                $end_for_identifier[$identifier] = $end
            }
        }
    }
}

# 优化：预先按标识符分组文件
$m4sFilesLookup = @{}
foreach ($identifier in $identifiers) {
    $pattern = '^P' + $identifier + '-([0-9.]+)-([0-9.]+)-([0-9]+)\.m4s$'
    $m4sFilesLookup[$identifier] = $m4sFiles | Where-Object { $_.Name -match $pattern } | Sort-Object -Property Name
    Write-Host "标识符 $identifier 有 $($m4sFilesLookup[$identifier].Count) 个文件"
}

# Sort identifiers numerically before processing
$sortedIdentifiers = $identifiers | Sort-Object -Property @{Expression={[int]$_}}
Write-Host "排序后的标识符顺序: $($sortedIdentifiers -join ', ')"

# Clear the concat file
Clear-Content -Path $dir_concat -ErrorAction SilentlyContinue

# Process each identifier in sorted order
foreach ($identifier in $sortedIdentifiers) {
    Write-Host "处理标识符: $identifier, 开始时间: $($start_for_identifier[$identifier]), 结束时间: $($end_for_identifier[$identifier])"
    
    $file_temp_pre = Join-Path -Path $folder_temp -ChildPath "Pre${identifier}.mp4"
    
    # 优化：如果文件已存在则删除
    if (Test-Path -Path $file_temp_pre) {
        Remove-Item -Path $file_temp_pre -Force
    }
    
    if ($init_file) {
        Write-Host "(Part$identifier) 添加初始化文件"
        # 优化：直接复制而不是流式处理
        Copy-Item -Path $init_file.FullName -Destination $file_temp_pre -Force
    }
    
    # 优化：使用预先分组的文件列表
    $filesForIdentifier = $m4sFilesLookup[$identifier]
    $fileCount = $filesForIdentifier.Count
    $processedCount = 0
    
    foreach ($file in $filesForIdentifier) {
        $processedCount++
        $percentComplete = [math]::Round(($processedCount / $fileCount) * 100)
        Write-Host "(Part$identifier) 添加 m4s 文件 [$processedCount/$fileCount] $percentComplete%: $($file.Name)"
        
        # 优化：使用高效的二进制合并
        if (!(Merge-BinaryFiles -TargetFile $file_temp_pre -SourceFile $file.FullName)) {
            # 如果合并失败，回退到复制
            if (!(Test-Path -Path $file_temp_pre)) {
                Copy-Item -Path $file.FullName -Destination $file_temp_pre -Force
            } else {
                # 回退到流式处理
                Get-Content -Path $file.FullName -AsByteStream | Add-Content -Path $file_temp_pre -AsByteStream
            }
        }
    }
    
    # Calculate duration
    $duration = Get-Duration -Start ([double]$start_for_identifier[$identifier]) -End ([double]$end_for_identifier[$identifier])
    if ([string]::IsNullOrEmpty($duration) -or $duration -notmatch '^[0-9]+(\.[0-9]+)?$' -or ($duration -as [double]) -le 0) {
       Write-Host "错误：无效的视频时长: $duration (start=$($start_for_identifier[$identifier]), end=$($end_for_identifier[$identifier]))"
        exit 1
    }
    
    Write-Host "(Part$identifier) 渲染临时文件，时长: $duration 秒"
    $file_temp = Join-Path -Path $folder_temp -ChildPath "Render${identifier}.mp4"

    # Check if temp file exists and is not empty.
    if (!(Test-Path -Path $file_temp_pre -PathType Leaf) -or (Get-Item -Path $file_temp_pre).Length -eq 0) {
      Write-Host "错误：临时文件为空: $file_temp_pre"
      exit 1
    }

    # 使用音频流修复函数
    if (!(Repair-AudioStream -InputFile $file_temp_pre -OutputFile $file_temp -Duration $duration)) {
        Write-Host "错误：无法修复音频流"
        exit 1
    }

    # Check output file
    if (!(Test-Path -Path $file_temp -PathType Leaf) -or (Get-Item -Path $file_temp).Length -eq 0) {
        Write-Host "错误：输出文件为空: $file_temp"
        exit 1
    }
    
    # Append to concat.txt - 优化：直接使用文件路径
    "file '$file_temp'" | Add-Content -Path $dir_concat
    
    # Remove temp pre file
    if (Test-Path -Path $file_temp_pre) {
        Remove-Item -Path $file_temp_pre -Force
    }
}

# Check concat.txt before final ffmpeg command
if (!(Test-Path -Path $dir_concat -PathType Leaf) -or (Get-Item -Path $dir_concat).Length -eq 0) {
    Write-Host "错误：concat.txt 文件为空或不存在"
    exit 1
}

# Final ffmpeg command
$name = Split-Path -Path $folder_dir -Leaf
$output_file = Join-Path -Path $folder_dir -ChildPath "$name.mp4"

# 优化：直接使用原始 concat 文件，不创建硬链接
Write-Host "临时 concat 文件内容:"
Get-Content -Path $dir_concat

# 使用音频流修复函数进行最终合并
Write-Host "执行最终合并..."
$final_concat_temp = Join-Path -Path $folder_temp -ChildPath "final_concat.txt"
Copy-Item -Path $dir_concat -Destination $final_concat_temp -Force

# 尝试多种最终合并策略
$final_strategies = @()
$final_strategies += @{
    Name = "Standard Concat"
    Args = @("-y", "-f", "concat", "-safe", "0", "-i", $final_concat_temp, "-c", "copy", "-fflags", "+discardcorrupt", "-ignore_unknown", $output_file)
}
$final_strategies += @{
    Name = "Re-encode Audio"
    Args = @("-y", "-f", "concat", "-safe", "0", "-i", $final_concat_temp, "-c:v", "copy", "-c:a", "aac", "-avoid_negative_ts", "make_zero", "-fflags", "+discardcorrupt", $output_file)
}
$final_strategies += @{
    Name = "Video Only"
    Args = @("-y", "-f", "concat", "-safe", "0", "-i", $final_concat_temp, "-c:v", "copy", "-an", $output_file)
}

$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Path
if (!$ffmpeg) {
    Write-Host "错误：未找到 ffmpeg。请安装 ffmpeg 并确保它在 PATH 中。"
    exit 1
}

$final_success = $false
foreach ($strategy in $final_strategies) {
    Write-Host "尝试最终合并策略: $($strategy.Name)"
    Write-Host "执行: ffmpeg $($strategy.Args -join ' ')"
    
    & $ffmpeg @($strategy.Args)
    if ($LASTEXITCODE -eq 0) {
        Write-Host "最终合并策略 '$($strategy.Name)' 成功"
        $final_success = $true
        break
    } else {
        Write-Host "最终合并策略 '$($strategy.Name)' 失败，尝试下一个..."
    }
}

if (!$final_success) {
    Write-Host "错误：所有最终合并策略都失败了"
    exit 1
}

# End of Main Script
#endregion

# Call cleanup function before script exit.
Cleanup -TempDir $folder_temp
Write-Host "完成。输出文件: $output_file" 