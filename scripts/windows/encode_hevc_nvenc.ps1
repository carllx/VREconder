# ./batch_toHEVC.ps1 -useHardwareAccel


param(
    [Parameter(Mandatory=$false)]
    [string]$mediaPath = "D:\\Downloads\\VR\\04_HEVC_Conversion_Queue",
    [Parameter(Mandatory=$false)]
    [int]$threads = 0,
    [Parameter(Mandatory=$false)]
    [string]$preset = "p5",  # 更慢的预设带来更好压缩率
    [Parameter(Mandatory=$false)]
    [switch]$useHardwareAccel,
    [Parameter(Mandatory=$false)]
    [int]$maxMuxingQueueSize = 4096
)

# 检查文件夹是否存在
if (!(Test-Path $mediaPath)) {
    Write-Error "错误：指定的文件夹不存在: $mediaPath"
    exit 1
}

# 检查必要工具
if (!(Get-Command mediainfo -ErrorAction SilentlyContinue) -or !(Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Error "错误：需要安装 mediainfo 和 ffmpeg"
    exit 1
}

Get-ChildItem $mediaPath -Filter *.mp4 | ForEach-Object {
    $mediaName = $_.Name
    $fullPath = Join-Path $mediaPath $mediaName

    # 获取视频编码格式
    $videoCodec = mediainfo --Output="Video;%Format%" $fullPath
    Write-Host "视频编码格式: $videoCodec"

    # 获取源文件的 CRF 值
    $CRF = mediainfo --Output="Video;%Encoded_Library_Settings%" $fullPath |
            Select-String -Pattern 'crf=(\d+(./d+)?)' -AllMatches |
            ForEach-Object { $_.Matches.Groups[1].Value }

    if ($null -eq $CRF) {
        $CRF = "23.0"
        Write-Host "未找到源文件 CRF 值，使用默认值: $CRF"
    }

    # 获取源文件的 bps 值 确保 mediainfo 命令可用并输出视频比特率（单位：bps）
    try {
        $mediaInfoOutput = mediainfo --Output="Video;%BitRate%" $fullPath
        if (-not $mediaInfoOutput) {
            Write-Error "无法获取视频比特率，请检查 mediainfo 是否安装或文件是否包含比特率信息。$fullPath"
            exit 1
        }
    } catch {
        Write-Error "mediainfo 执行出错：$_"
        exit 1
    }
    # 将获取的比特率转换为整数
    try {
        [int]$originalBitrate = [math]::Round([double]$mediaInfoOutput)
    } catch {
        Write-Error "比特率转换错误，请检查 mediainfo 输出格式：$mediaInfoOutput, $originalBitrate"
        exit 1
    }
    $targetBitrate = [math]::Round($originalBitrate * 0.7)

    $outputPath = Join-Path $mediaPath "$mediaName - (HEVC_$CRF)"
    Write-Host "正在处理: $mediaName"

    try {
        # 获取视频分辨率
        $videoResolution = mediainfo --Output="Video;%Width% %Height%" $fullPath
        $width, $height = $videoResolution -split ' '

        # 判断是否需要缩放
        if ($width -gt 4096) {
            $scaleArgs = @("-vf", "scale=min(4096\,iw):-2")
            
        } else {
            
        $scaleArgs = @()
        
        }
        # $scaleArg = if ($width -gt 4096) { @("-vf", "scale=min(4096\,iw):-2") } else { @() }
        $gpuInfo = & nvidia-smi --query-gpu=gpu_name --format=csv,noheader 2>$null
        # FFmpeg参数设置
        $ffmpegArgs = $ffmpegArgs = @(
            "-i", $fullPath
        ) + $scaleArgs + @(
            "-threads", $threads,
            "-c:v", "hevc_nvenc",
            "-max_muxing_queue_size", $maxMuxingQueueSize,
            "-preset", $preset,
            "-tune", "hq",
            "-multipass", "1",
            "-profile:v", "main",
            "-rc", "vbr_hq",
            "-b:v", "${targetBitrate}",  # 按70%源文件码率设置
            "-maxrate", "${originalBitrate}",  # 设置最大码率缓冲
            # "-crf", 23,
            "-cq", "23",       # 注意参数名是cq不是crf
            "-qmin", "0",      # 添加量化范围限制
            "-qmax", "51",
            "-flags", "+cgop",
            "-g", "120",
            "-rc-lookahead", "48",
            "-level", "5.1",
            "-movflags", "+faststart",
            "-metadata", "stereo_mode=left_right",
            "-c:a", "aac",
            "-stats",
            "-progress", "pipe:1",
            "-f", "mp4",
            "-y", "$outputPath.mp4"
            )
            # "-b:v", "${originalBitrate}",
            # "-crf", $CRF,
        Write-Host "使用 NVIDIA GPU 硬件加速: $gpuInfo"
        Write-Host "使用 NVENC 编码器和优化参数"
        Write-Host "开始转码，使用Bit Rate：$originalBitrate bps"
        Write-Host "是否需要 Scale: $width => $scaleArg" # 打印是否需要缩放的信息
        Write-Host "Preset: $preset"
        Write-Host "Threads: $threads"
        Write-Host "CRF值: $CRF"
        Write-Host "硬件加速: $useHardwareAccel"

        & ffmpeg $ffmpegArgs
        Write-Host "转换完成: $outputPath"
    }
    catch {
        Write-Host "处理文件时出错: $mediaName"
        Write-Error "错误信息: $($_.Exception.Message)"
    }
}