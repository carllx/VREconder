# param (
#     [Parameter(Mandatory=$true)]
#     [string]$mediaPath
# )
$mediaPath = "${PROJECT_ROOT}\01_Download_Completed"
$destination8K = "${PROJECT_ROOT}\01_8K_Raw"
$destination4K = "${PROJECT_ROOT}\02_4K_Edit_Ready"

$allVideoFolders = Get-ChildItem $mediaPath -Directory

Write-Host "... processing $allVideoFolders"

foreach ($folder in $allVideoFolders) {
    $has8K = $false
    $has4K = $false
    $allVideos = Get-ChildItem $folder.FullName -Filter *.mp4 -File
    $folderPath = $folder.FullName
    foreach ($video in $allVideos) {

        $fullPath = $video.FullName
        $extension = $video.Extension
        $mediaName = $video.BaseName

        Write-Host " Getting media info $mediaName"
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
            $newPath = Join-Path -Path $folderPath -ChildPath $newFileName

            Rename-Item $fullPath -NewName $newFileName
            Write-Host " Renamed $fullPath to $newFileName"
            if ($height -gt 2160) {
                $has8K = $true
            } else {
                $has4K = $true
            }
        } else {
            Write-Host "Unable to parse the media information of the file: $fullPath"
        }
    }
    if ($has8K -and !$has4K) {
        Write-Host " All videos in $folderPath are 8K or above and the folder will be moved to $destination8K"
        Move-Item -Path $folderPath -Destination $destination8K
    } elseif (!$has8K -and $has4K) {
        Write-Host " All videos in $folderPath are below 8K and the folder will be moved to $destination4K"
        Move-Item -Path $folderPath -Destination $destination4K
    } else {
        Write-Host " There are both 8K and non-8K videos in the folder, and the files have been renamed but the folder remains in the original location"
    }
}
