#!/bin/bash

# Define the directory containing the videos
FOLDER="/Volumes/Media/VR/Batch/_MacOS Batch/"

# Create or clear the existing CSV file
echo "Filename,crf, Format,Codec Id,CodecIDInfo,Format Profile,Format Info,Duration,File Size" > "$FOLDER/video_info.csv"

# Loop through each file in the directory
for FILE in "$FOLDER"*; do
    # Check if it's a file and not a directory
    if [ -f "$FILE" ]; then
        # Get the filename without path
        FILENAME=$(basename "$FILE")
        
        # Get video format and codec information using mediainfo
        FORMAT=$(mediainfo --Output="Video;%Format%" "$FILE")
        # Extract the CodecID, assuming it's within the <CodecID> tag
        # This assumes that the format is consistent and that the tag is present
        CODECID=$(mediainfo --Output="Video;%CodecID%" "$FILE")
        CodecIDInfo=$(mediainfo --Output="Video;%CodecID/Info%" "$FILE")
        FormatProfile=$(mediainfo --Output="Video;%Format_Profile%" "$FILE")
        FormatInfo=$(mediainfo --Output="Video;%Format/Info%" "$FILE")
        DURATION=$(mediainfo --Output="Video;%Duration%" "$FILE")
        FILESIZE=$(mediainfo --Output="General;%FileSize%" "$FILE")    
        CRF=CRF=$(mediainfo --Output="Video;%Encoded_Library_Settings%" "$FILE" | perl -ne 'print $1 if /crf=(\d+(./d+)?)/') 

        # Append the information to the CSV file
        echo "$FILENAME,$CRF,$FORMAT,$CODECID,$CodecIDInfo,$FormatProfile,$FormatInfo,$DURATION,$FILESIZE" >> "$FOLDER/video_info.csv"
    fi
done


echo "CSV file created successfully at $FOLDER/video_info.csv"
