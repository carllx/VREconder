#!/usr/bin/env bash

# 检查命令行参数
if [ $# -eq 0 ]; then
    echo "请提供文件夹路径"
    echo "用法: $0 <文件夹路径>"
    exit 1
fi

# Define variables first
folder_dir="$1"
folder_temp="$folder_dir/temp"
dir_concat="${folder_temp}/concat.txt"

# 检查文件夹是否存在
if [ ! -d "$folder_dir" ]; then
    echo "错误：文件夹不存在: $folder_dir"
    exit 1
fi

# Then create directory
mkdir -p "$folder_temp"
set -e

init_file="$(find "$folder_dir" -maxdepth 1 -type f -name init.mp4)"

declare -A start_for_identifier
declare -A end_for_identifier
declare -a identifiers

for file in "$folder_dir"/*; do
    filename=$(basename "$file")
    # 修改正则表达式以匹配浮点数
    if [[ "$filename" =~ ^P([0-9]+)-([0-9.]+)-([0-9.]+)-[0-9]+\.m4s$ ]]; then
        identifier="${BASH_REMATCH[1]}"
        start="${BASH_REMATCH[2]}"
        end="${BASH_REMATCH[3]}"
        
        echo "解析文件: $filename"
        echo "正则匹配结果: ${BASH_REMATCH[*]}"
        echo "解析结果: identifier=$identifier, start=$start, end=$end"
        
        if [[ -n "$identifier" && -n "$start" && -n "$end" ]]; then
            if [[ -z "${start_for_identifier[$identifier]}" ]]; then
                identifiers+=("$identifier")
            fi

            if [[ -z "${start_for_identifier[$identifier]}" || "${start_for_identifier[$identifier]}" -gt "$start" ]]; then
                start_for_identifier[$identifier]="$start"
            fi

            if [[ -z "${end_for_identifier[$identifier]}" || "${end_for_identifier[$identifier]}" -lt "$end" ]]; then
                end_for_identifier[$identifier]="$end"
            fi
        else
            echo "警告：文件 $filename 解析出的值无效"
            echo "identifier: $identifier, start: $start, end: $end"
        fi
    fi
done

# Clear the concat file before writing
> "$dir_concat"

for identifier in "${identifiers[@]}"; do
    echo "Identifier: $identifier, Start: ${start_for_identifier[$identifier]}, End: ${end_for_identifier[$identifier]}"
    
    videoFiles=()
    file_temp_pre="$folder_temp/Pre${identifier}.mp4"
    mkdir -p "$(dirname "$file_temp_pre")"
    
    if [ -n "$init_file" ]; then
        echo "(Part$identifier) Adding init file to temp"
        cat "$init_file" >> "$file_temp_pre"
    fi

    find "$folder_dir" -type f -iname "P${identifier}*.m4s" -print0 | sort -z -V | while IFS= read -r -d '' file; do
        echo "(Part$identifier) Adding m4s to temp"
        cat "$file" >> "$file_temp_pre"
    done
    
    # 修改 duration 计算和验证
    duration=$(echo "${end_for_identifier[$identifier]} - ${start_for_identifier[$identifier]}" | bc -l)
    if [[ -n "$duration" && "$duration" =~ ^[0-9]+(\.[0-9]+)?$ && $(echo "$duration > 0" | bc -l) -eq 1 ]]; then
        echo "(Part$identifier) Rendering temp file with seconds: ${duration}"
        file_temp="$folder_temp/Render${identifier}.mp4"
        
        # 添加文件大小检查
        if [ ! -s "$file_temp_pre" ]; then
            echo "错误：临时文件为空: $file_temp_pre"
            exit 1
        fi
        
        if ! ffmpeg -y -i "$file_temp_pre" -ss 0 -c copy -t "$duration" "$file_temp"; then
            echo "错误：ffmpeg 处理失败"
            exit 1
        fi
        
        # 添加输出文件检查
        if [ ! -s "$file_temp" ]; then
            echo "错误：输出文件为空: $file_temp"
            exit 1
        fi
    else
        echo "错误：无效的视频时长: $duration (start=${start_for_identifier[$identifier]}, end=${end_for_identifier[$identifier]})"
        exit 1
    fi
    
    # 使用 printf 和转义处理写入路径
    # 修改写入方式，不使用转义
    # Append to concat.txt
    echo "file '$file_temp'" >> "$dir_concat"
    
    # 安全地删除临时文件
    if [ -f "$file_temp_pre" ]; then
        rm -f "$file_temp_pre" || true
    fi
done

# 在最终 ffmpeg 命令之前添加检查
if [ ! -s "$dir_concat" ]; then
    echo "错误：concat.txt 文件为空或不存在"
    exit 1
fi

# 修改最终的 ffmpeg 命令部分
name=$(basename "$folder_dir")
output_file="$folder_dir/$name.mp4"

# 创建新的 concat 文件，使用简单路径
temp_concat="${folder_temp}/temp_concat.txt"
> "$temp_concat"

# 创建符号链接目录
link_dir="${folder_temp}/links"
mkdir -p "$link_dir"
rm -f "${link_dir}"/* 2>/dev/null || true

# 为每个视频文件创建符号链接
counter=1
while IFS= read -r line; do
    file_path=$(echo "$line" | sed -n "s/file '\(.*\)'/\1/p")
    link_name="${link_dir}/part${counter}.mp4"
    ln -sf "$file_path" "$link_name"
    echo "file '$link_name'" >> "$temp_concat"
    ((counter++))
done < "$dir_concat"

# 添加调试信息
echo "临时 concat 文件内容:"
cat "$temp_concat"

# 使用符号链接进行合并
ffmpeg -y -f concat -safe 0 -i "$temp_concat" -c copy "$output_file"

# 修改清理逻辑
cleanup() {
    local temp_dir="$1"
    if [ -d "$temp_dir" ]; then
        # 清理符号链接目录
        rm -rf "${temp_dir}/links"
        # 清理其他临时文件
        find "$temp_dir" -type f -exec rm -f {} \;
        rmdir "$temp_dir" 2>/dev/null || true
    fi
}
trap 'cleanup "$folder_temp"' EXIT