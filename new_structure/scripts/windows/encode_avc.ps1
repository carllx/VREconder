# Win11 to AVC

# 批量转换视频到 H.264/AVC 格式
# 用法：
# # 基本使用
# ./batch_toAVC.ps1

# # 使用硬件加速
# ./batch_toAVC.ps1 -useHardwareAccel

# # 自定义参数
# ./batch_toAVC.ps1 -preset veryslow -threads 16 -useHardwareAccel

param(
    [Parameter(Mandatory=$false)]
    [string]$mediaPath = "${PROJECT_ROOT}\04_HEVC_Conversion_Queue",
    [Parameter(Mandatory=$false)]
    [int]$threads = 0,
    [Parameter(Mandatory=$false)]
    [string]$preset = "slower",
    [Parameter(Mandatory=$false)]
    [switch]$useHardwareAccel,
    [Parameter(Mandatory=$false)]
    [int]$maxMuxingQueueSize = 4320
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
           Select-String -Pattern 'crf=(\d+(\./d+)?)' -AllMatches | 
           ForEach-Object { $_.Matches.Groups[1].Value }
    
    if ($null -eq $CRF) {
        $CRF = "23.0"
        Write-Host "未找到源文件 CRF 值，使用默认值: $CRF"
    }
    
    $outputPath = Join-Path $mediaPath "$mediaName - (AVC_$CRF).mp4"
    
    Write-Host "正在处理: $mediaName"
    try {
        $ffmpegArgs = @(
            "-i", $fullPath,
            "-max_muxing_queue_size", $maxMuxingQueueSize,
            "-c:v", "libx264",
            "-threads", $threads,
            "-preset", $preset,
            "-profile:v", "high",
            "-tune", "film",
            "-bf", "2",
            "-flags", "+cgop",
            "-g", "30",
            "-crf", $CRF,
            "-x264-params", "ref=6:me=umh:subme=9:trellis=2:deblock=1,1",
            "-movflags", "+faststart",
            "-metadata", "stereo_mode=left_right",
            "-c:a", "aac",
            "-stats",
            "-progress", "pipe:1",
            "-f", "mp4",
            "-y", $outputPath
        )

        # 如果启用硬件加速（NVIDIA GPU）
        if ($useHardwareAccel) {
            # 检查 NVIDIA GPU 是否可用
            $gpuInfo = & nvidia-smi --query-gpu=gpu_name --format=csv,noheader 2>$null
            if ($?) {
                # 检查视频编码格式是否支持硬件加速
                $supportedCodecs = @("AVC", "H264", "HEVC", "H265")
                if ($supportedCodecs -contains $videoCodec) {
                    $ffmpegArgs = @(
                        "-hwaccel", "cuda",
                        "-hwaccel_output_format", "cuda",
                        "-extra_hw_frames", "3",
                        "-i", $fullPath,
                        "-max_muxing_queue_size", $maxMuxingQueueSize,
                        "-c:v", "hevc_nvenc",     # 使用 NVENC 编码器
                        "-preset", "p4",           # Quadro 系列推荐使用 p4 预设
                        "-rc", "vbr",             # 可变比特率模式
                        "-cq", "23",              # 恒定质量参数
                        "-profile:v", "high",
                        "-bf", "2",
                        "-g", "30",               # GOP 大小
                        "-rc-lookahead", "20",    # 前瞻帧数
                        "-movflags", "+faststart",
                        "-metadata", "stereo_mode=left_right",
                        "-c:a", "acc",
                        "-vsync", "0",            # 防止输出重复帧
                        "-stats",
                        "-progress", "pipe:1",
                        "-y", $outputPath
                    )
            
                    Write-Host "使用 NVIDIA GPU 硬件加速: $gpuInfo"
                    Write-Host "使用 NVENC 编码器和优化参数"
                }
            }
        }

        Write-Host "开始转码，使用参数："
        Write-Host "预设: $preset"
        Write-Host "线程数: $threads"
        Write-Host "CRF值: $CRF"
        Write-Host "硬件加速: $useHardwareAccel"

        & ffmpeg $ffmpegArgs

        Write-Host "转换完成: $outputPath"
    }
    catch {
        Write-Error "处理文件时出错: $mediaName`n$($_.Exception.Message)"
    }
}
