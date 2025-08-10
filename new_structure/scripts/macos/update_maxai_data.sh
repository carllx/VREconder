#!/bin/bash

# 设置数据文件路径
DATA_FILE="/Users/yamlam/Documents/obsdiannote/.obsidian/plugins/ObsAI/data.json"

# 记录脚本开始执行
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 脚本开始执行" > /tmp/maxai_debug.log

# 将输入参数进行预处理并保存到临时文件
echo "$1" | python3 -c '
import sys, json, re

try:
    # 读取输入并清理
    data = sys.stdin.read()
    # 清理控制字符
    data = re.sub(r"[\x00-\x1F\x7F-\x9F]", " ", data)
    # 处理双引号问题
    data = data.replace("\\\\", "\\").replace('\\"', '"')
    # 记录处理后的数据
    with open("/tmp/maxai_debug.log", "a") as log:
        log.write("\n处理后的数据: " + data)
    # 解析并重新序列化
    parsed = json.loads(data)
    # 确保 deviceId 格式正确
    if "deviceId" in parsed:
        parsed["deviceId"] = parsed["deviceId"].strip('"')
    result = json.dumps(parsed, ensure_ascii=False)
    print(result)
except Exception as e:
    print("预处理错误：" + str(e), file=sys.stderr)
    with open("/tmp/maxai_debug.log", "a") as log:
        log.write("\n原始输入: " + data)
        log.write("\n错误信息: " + str(e))
    sys.exit(1)
' > /tmp/maxai_input.json

# 使用 Python 处理 JSON 数据
python3 << EOF
import json
import sys
import os

try:
    # 从临时文件读取 JSON 数据
    with open('/tmp/maxai_input.json', 'r', encoding='utf-8') as f:
        json_data = json.load(f)
    
    # 读取现有文件
    with open('$DATA_FILE', 'r+', encoding='utf-8') as f:
        data = json.load(f)
        # 更新 maxai 对象
        data['maxai'] = {
            'accessToken': json_data['accessToken'],
            'userId': json_data['userId'],
            'deviceId': json_data['deviceId'].strip('"'),
            'timeDiff': json_data['timeDiff'],
            'userAgent': json_data['userAgent'],
            'signKey': json_data['signKey'],
            'baseUrl': json_data['baseUrl']
        }
        # 重写整个文件
        f.seek(0)
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.truncate()
    
    print("数据已更新")
    
except Exception as e:
    print(f"错误：{str(e)}", file=sys.stderr)
    sys.exit(1)

finally:
    if os.path.exists('/tmp/maxai_input.json'):
        os.remove('/tmp/maxai_input.json')
EOF

# 检查执行结果
if [ $? -eq 0 ]; then
    echo "更新成功" >> /tmp/maxai_debug.log
else
    echo "更新失败" >> /tmp/maxai_debug.log
fi

# 清空并开始记录调试信息
echo "===============开始执行===============" > /tmp/maxai_debug.log
echo "脚本路径: $0" >> /tmp/maxai_debug.log
echo "参数: $1" >> /tmp/maxai_debug.log
echo "当前目录: $(pwd)" >> /tmp/maxai_debug.log
echo "数据文件路径: $DATA_FILE" >> /tmp/maxai_debug.log

# 确保数据文件存在
if [ ! -f "$DATA_FILE" ]; then
    echo "错误：数据文件不存在: $DATA_FILE" >> /tmp/maxai_debug.log
    exit 1
fi

# 确保参数不为空
if [ -z "$1" ]; then
    echo "错误：没有接收到参数" >> /tmp/maxai_debug.log
    exit 1
fi

# 保存输入数据到临时文件
echo "$1" > /tmp/maxai_input.json
echo "已保存输入数据到临时文件" >> /tmp/maxai_debug.log

# 使用 Python 处理 JSON 数据
python3 << EOF
import json
import sys
import os

try:
    print("Python 脚本开始执行")
    
    # 从临时文件读取数据
    with open('/tmp/maxai_input.json', 'r') as f:
        input_data = f.read().strip()
        print(f"读取到的输入数据: {input_data}")
    
    # 解析 JSON 数据
    json_data = json.loads(input_data)
    
    # 读取现有文件
    with open('$DATA_FILE', 'r', encoding='utf-8') as f:
        existing_data = json.load(f)
    
    # 构建 maxai 对象
    maxai_data = {
        'accessToken': json_data['accessToken'],
        'userId': json_data['userId'],
        'deviceId': json_data['deviceId'].strip('"'),
        'timeDiff': json_data['timeDiff'],
        'userAgent': json_data['userAgent'],
        'signKey': json_data['signKey'],
        'baseUrl': json_data['baseUrl']
    }
    
    # 更新 maxai 对象
    existing_data['maxai'] = maxai_data
    
    # 写入更新后的数据
    with open('$DATA_FILE', 'w', encoding='utf-8') as f:
        json.dump(existing_data, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    
    print("数据已成功写入文件")
    sys.exit(0)

except Exception as e:
    print(f"错误：{str(e)}", file=sys.stderr)
    sys.exit(1)

finally:
    if os.path.exists('/tmp/maxai_input.json'):
        os.remove('/tmp/maxai_input.json')
EOF

# 检查 Python 脚本的执行结果
RESULT=$?
if [ $RESULT -eq 0 ]; then
    echo "脚本执行成功" >> /tmp/maxai_debug.log
    cat "$DATA_FILE" >> /tmp/maxai_debug.log
else
    echo "脚本执行失败，错误码: $RESULT" >> /tmp/maxai_debug.log
fi

echo "===============执行结束===============" >> /tmp/maxai_debug.log

# 输出调试日志位置
echo "详细日志请查看: /tmp/maxai_debug.log"