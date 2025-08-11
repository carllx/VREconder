mediaPath="/Volumes/Media/VR/VR_Video_Processing/04_HEVC_Conversion_Queue"
completedPath="/Volumes/Media/VR/VR_Video_Processing/04_HEVC_Conversion_Queue/Completed"

# 添加参数处理
encoder="hevc_videotoolbox"  # 默认使用 hevc_videotoolbox

while getopts "e:" opt; do
  case $opt in
    e)
      if [[ "$OPTARG" == "libx265" || "$OPTARG" == "hevc_videotoolbox" ]]; then
        encoder="$OPTARG"
      else
        echo "Invalid encoder option. Use 'libx265' or 'hevc_videotoolbox'."
        exit 1
      fi
      ;;
    *)
      echo "Usage: $0 [-e encoder]"
      exit 1
      ;;
  esac
done

for filePath in "$mediaPath"/*.mp4; do
  fileName=$(basename "$filePath")
  if [[ $fileName =~ ^[0-9]+\_[0-9]+\_crf[a-z0-9]+\_[a-z0-9]+\-.*\.mp4$ ]]; then 
    echo "Filename matches expected pattern: $fileName"
    
    # Use bash-compatible syntax to split the filename
    IFS='_' read -r -a parts <<< "$fileName"
    width=${parts[0]}
    height=${parts[1]}
    crfInfo=${parts[2]}
    mediaNameWithExt="${fileName%.mp4}"
    mediaName="${mediaNameWithExt#*-}"
    crfValue="${crfInfo#crf}"
    # if crfValue is unknown set crfValue to 23
    if [[ -z "$crfValue" || "$crfValue" == "unknown" || "$crfValue" == "un" ]]; then
      crfValue=23
    fi
    ffmpegCommand="ffmpeg -i \"$filePath\""

    if (( height > 2160 )); then
      newWidth=$(( width * 2160 / height ))
      # 不强制调整 CRF 值
      ffmpegCommand+=" -vf scale=${newWidth}:2160:flags=lanczos"
    fi

    # 根据选择的编码器设置 ffmpegCommand
    if [[ "$encoder" == "libx265" ]]; then
      ffmpegCommand+=" -c:v libx265 -crf ${crfValue} -preset medium"
      outputFileName="${mediaName}-(HEVC_${crfValue}_libx265).mp4"
    else
      ffmpegCommand+=" -c:v hevc_videotoolbox"
      outputFileName="${mediaName}-(HEVC_videotoolbox).mp4"
    fi

    # 重新编码音频以降低码率
    ffmpegCommand+=" -c:a libmp3lame -b:a 128k"
    ffmpegCommand+=" -metadata stereo_mode=left_right -movflags +faststart"
    
    outputPath="${filePath%/*}/$outputFileName"
    
    ffmpegCommand+=" \"$outputPath\""
    # Use eval with escaped quotes
    eval "$ffmpegCommand"
    echo "Processed file: $filePath -> $outputPath"

  else
    echo "Filename does not match expected pattern: $fileName"
  fi
done

# # 如果需要更高质量，可以使用 libx265 编码器
# bash '/Volumes/app/04_batch_toHEVC(macOS).sh' -e libx265

# # hevc_videotoolbox
# bash '/Volumes/app/04_batch_toHEVC(macOS).sh' -e hevc_videotoolbox

# -c:v hevc_videotoolbox -c:v hevc_videotoolbox(macOS) 或 -c:v hevc_nvenc(NVIDIA GPU)
# If you don't need to scale the videos and want to keep them at their original resolution
# removing this line between '-pix_fmt' and '-movflags'
# -vf "scale=3024:1512:flags=lanczos"
# -pix_fmt yuv420p10le , 如果原视频是 10bit 这个选项没有必要
# 如果追求极致画质: 可以尝试提高码率到 30-40 Mbps 
# 如果原视频是 avc1 或 hev1 , 并通过crf 23 转换过的, 当我将它转换成hevc 格式时 选择crf 18 会得到更高质量的画质?

# CRF（Constant Rate Factor）相比，ABR（Average Bit Rate）确实存在一些缺点：
# CRF在质量控制和编码效率方面通常优于ABR，但ABR在精确控制文件大小时更有优势。对于需要严格控制带宽的流媒体应用，ABR可能更合适，而对于追求质量一致性的离线编码，CRF通常是更好的选择。