$mediaPath="C:\Users\carll\Downloads\VR\04_HEVC_Conversion_Queue\"

Get-ChildItem -Path $mediaPath -Filter *.mp4 | ForEach-Object {
    $filePath = $_.FullName
    $fileName = $_.Name
    if ($fileName -match '^[0-9]+_[0-9]+_crf[a-z0-9]+_[a-z0-9]+-.*\.mp4$') {
        Write-Host "The file name matches the expected pattern: $fileName"
        
        $parts = $fileName -split '_'
        $width = [int]$parts[0]
        $height = [int]$parts[1]
        $crfInfo = $parts[2]
        $mediaNameWithExt = $fileName -replace '\.mp4$', ''
        $mediaName = $mediaNameWithExt -replace '^.*?-', ''
        $crfValue = $crfInfo -replace 'crf', ''
        
        # 增加默认CRF值，使压缩更强（原来是21，现在改为26）
        if ([string]::IsNullOrEmpty($crfValue) -or $crfValue -eq "unknown") {
            $crfValue = 26
        } else {
            # 如果有指定CRF值，增加5以提高压缩率
            $crfValue = [int]$crfValue + 5
        }
        
        $ffmpegCommand = "ffmpeg -i `"$($_.FullName)`""

        if ($height -gt 2160) {
            $newWidth = [math]::Floor($width * 2160 / $height)
            # 即使对于高分辨率视频，也使用更高的CRF值
            $crfValue = 23
            $ffmpegCommand += " -vf scale=${newWidth}:2160:flags=lanczos"
        }

        $ffmpegCommand+=" -c:v libx265"
        # 使用更慢的预设以获得更好的压缩率，并添加x265特定参数
        $ffmpegCommand+=" -crf ${crfValue} -preset slower -c:a copy"
        $ffmpegCommand+=" -pix_fmt yuv420p10le"
        # 添加x265特定参数以提高压缩效率
        $ffmpegCommand+=" -x265-params me=3:rd=4:subme=5:aq-mode=3:aq-strength=0.8:deblock=1,1"
        $ffmpegCommand+=" -metadata stereo_mode=left_right -movflags +faststart"

        $outputFileName = "${mediaName}-(HEVC_${crfValue}_libx265_optimized).mp4"
        $outputPath = Join-Path (Split-Path $filePath) $outputFileName
        $ffmpegCommand += " `"$outputPath`""

        Write-Host "开始转换: $fileName"
        Write-Host "FFmpeg Command: $ffmpegCommand"
        Invoke-Expression $ffmpegCommand
        Write-Host "转换完成: $outputFileName"
    }else {
        Write-Host " The file name does not match the expected pattern: $fileName"
    }
}