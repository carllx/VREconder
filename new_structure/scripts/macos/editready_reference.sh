# ffmpeg-python Conversion_Queue
# .wispperX
ffmpeg 
 
 -hide_banner 
 -ss '45.57451' 
 -i 'G:\Download\completed\4k\8k 
 - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_3_8k.mp4' 
 -t '297.94072' 
 -avoid_negative_ts make_zero 
 -map '0:0' '-c:0' copy '-tag:0' hvc1 
 -map '0:1' '-c:1' copy 
 -map_metadata 0 
 -movflags '+faststart' 
 -default_mode infer_no_subs 
 -ignore_unknown 
 -f mp4 
 -y 'G:\Download\completed\4k\8k  - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_3_8k-00.00.45.575-00.05.43.515-seg1.mp4'


ffmpeg 
 -hide_banner 
 -ss '766.09052' 
 -i 'G:\Download\completed\4k\8k 
 - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_3_8k.mp4' 
 -t '77.16706' 
 -avoid_negative_ts make_zero 
 -map '0:0' '-c:0' copy '-tag:0' hvc1 
 -map '0:1' '-c:1' copy 
 -map_metadata 0 
 -movflags '+faststart' 
 -default_mode infer_no_subs 
 -ignore_unknown 
 -f mp4 
 -y 'G:\Download\completed\4k\8k 
 - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_3_8k-00.12.46.091-00.14.03.258-seg5.mp4'


echo -e "
file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_6_8k-00.06.56.820-00.08.14.730-seg1.mp4'
file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_6_8k-00.09.16.957-00.10.53.750-seg2.mp4'
file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_6_8k-00.13.22.083-00.14.53.914-seg3.mp4'
file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_6_8k-00.16.12.642-00.17.03.817-seg4.mp4'
file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_6_8k-00.18.00.336-00.31.10.029-seg5.mp4'" | 
ffmpeg
     -hide_banner
     -f concat
     -safe 0
     -protocol_whitelist 'file,pipe,fd'
     -i
     -
     -i 'G:\Download\completed\4k\8k
     - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_6_8k-00.06.56.820-00.08.14.730-seg1.mp4'
     -f ffmetadata
     -i 'G:\Download\completed\4k\8k
     - mdvr-278\ffmetadata-1720347129253.txt'
     -map '0:0' '-c:0' copy '-tag:0' hvc1 '-disposition:0' default
     -map '0:1' '-c:1' copy '-disposition:1' default
     -map_metadata 1
     -map_chapters 2
     -movflags '+faststart'
     -default_mode infer_no_subs
     -ignore_unknown
     -f mp4
     -y 'G:\Download\completed\4k\8k
     - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_6_8k-cut-merged-1720347037457.mp4'

echo
     -e "file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_3_8k-00.00.45.575-00.05.43.515-seg1.mp4'\nfile 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_3_8k-00.08.33.966-00.09.56.136-seg2.mp4'
file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_3_8k-00.10.45.794-00.11.07.927-seg3.mp4'
file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_3_8k-00.11.27.112-00.12.11.522-seg4.mp4'
file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_3_8k-00.12.46.091-00.14.03.258-seg5.mp4'
file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_3_8k-00.14.53.358-00.17.13.550-seg6.mp4'
file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_3_8k-00.17.33.734-00.21.18.158-seg7.mp4'
file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_6_8k-00.06.56.820-00.08.14.730-seg1.mp4'
file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_6_8k-00.09.16.957-00.10.53.750-seg2.mp4'
file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_6_8k-00.13.22.083-00.14.53.914-seg3.mp4'
file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_6_8k-00.16.12.642-00.17.03.817-seg4.mp4'
file 'file:G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_6_8k-00.18.00.336-00.31.10.029-seg5.mp4'" | ffmpeg -hide_banner -f concat -safe 0 -protocol_whitelist 'file,pipe,fd' -i - -i 'G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_3_8k-00.00.45.575-00.05.43.515-seg1.mp4' -f ffmetadata -i 'G:\Download\completed\4k\8k - mdvr-278\ffmetadata-1720347714141.txt' -map '0:0' '-c:0' copy '-tag:0' hvc1 '-disposition:0' default -map '0:1' '-c:1' copy '-disposition:1' default -map_metadata 1 -map_chapters 2 -movflags '+faststart' -default_mode infer_no_subs -ignore_unknown -f mp4 -y 'G:\Download\completed\4k\8k - mdvr-278\8192_4096_crf23_hev1-4k2.com@mdvr-278_3_8k-00.00.45.575-00.05.43.515-seg1-merged-1720347708267.mp4'