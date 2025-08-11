$mediaPath = "${PROJECT_ROOT}\01_Download_Completed"
$destination8K = "${PROJECT_ROOT}\02_8K_Raw"
$destination4K = "${PROJECT_ROOT}\03_4K_Edit_Ready"

$subfolders = Get-ChildItem $mediaPath -Directory

foreach ($subfolder in $subfolders) {
    $allVideos = Get-ChildItem $subfolder.FullName -Filter *.mp4 -File
    $all8K = $true
    $all4K = $true

    foreach ($file in $allVideos) {
        $fullPath = $file.FullName
        $extension = $file.Extension
        $mediaName = $file.BaseName

        $mediaInfo = mediainfo --Output="Video;%Width%,%Height%,%CodecID%,%Encoded_Library_Settings%" $fullPath

        if ($mediaInfo -match '(\d+),(\d+),([A-Za-z0-9]+),(.*)') {
            $width = [int]$Matches[1]
            $height = [int]$Matches[2]
            $CodecID = $Matches[3]
            $encodedSettings = $Matches[4]

            $CRFMatch = [regex]::Match($encodedSettings, 'crf=(\d+(\./d+)?)')
            $CRF = if ($CRFMatch.Success) { $CRFMatch.Groups[1].Value } else { 'unknown' }
            $crfIntegerPart = $CRF -replace '(\d+)(\./d+)?$', '$1'

            $newFileName = "{0}_{1}_crf{2}_{3}-{4}{5}" -f $width, $height, $crfIntegerPart, $CodecID, $mediaName, $extension
            $newPath = Join-Path -Path $subfolder.FullName -ChildPath $newFileName

            Rename-Item $fullPath -NewName $newPath

            if ($width -lt 7680 -or $height -lt 4320) {
                $all8K = $false
            }
            if ($width -ge 7680 -and $height -ge 4320) {
                $all4K = $false
            }
        } else {
            Write-Host "无法解析文件的媒体信息: $fullPath"
        }
    }

    if ($all8K) {
        Move-Item -Path $subfolder.FullName -Destination $destination8K
        Write-Host "文件夹 $($subfolder.Name) 中所有视频都是8K，已移动到 $destination8K"
    } elseif ($all4K) {
        Move-Item -Path $subfolder.FullName -Destination $destination4K
        Write-Host "文件夹 $($subfolder.Name) 中所有视频都低于8K，已移动到 $destination4K"
    } else {
        Write-Host "文件夹 $($subfolder.Name) 内同时存在8K和非8K视频，文件已重命名但保留在原文件夹中"
    }
}
