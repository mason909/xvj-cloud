#!/bin/bash
# 第4轮审计修复上线后的服务端证据验证。
# 只操作临时房间（ZZROUND4 前缀，测完删除）与不存在的设备 id；绝不碰真实设备 ee9e3c13*。
# 全部测试数据 ASCII：curl 传中文会破坏数据。
K="xvj_secret_key_2024"
B="http://localhost:3000"
pass=0; fail=0
chk() { # chk 名称 期望 实际
  if [ "$2" = "$3" ]; then echo "  OK   $1 ($3)"; pass=$((pass+1));
  else echo "  FAIL $1 expected=$2 got=$3"; fail=$((fail+1)); fi
}
# 只回 HTTP 状态码；-m 8 让"挂起不返回"变成超时码 28（正是旧 bug 的形状）
st() { curl -s -o /tmp/body.out -w '%{http_code}' -m 8 "$@"; }

echo "== 0) 真实房间快照（前后比对，证明测试没动生产数据）"
curl -s -m 8 "$B/api/rooms" > /tmp/rooms-before.json
node -e "const r=require('/tmp/rooms-before.json');console.log('  rooms='+r.length+' ids='+r.map(x=>x.id).sort().join(','))"

echo "== 1) 建临时房间"
RID=$(curl -s -m 8 -X POST "$B/api/rooms" -H "x-api-key: $K" -H 'Content-Type: application/json' \
  -d '{"store_name":"ZZROUND4","name":"zz-round4-room"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id||''))")
chk "临时房间已创建" "yes" "$([ -n "$RID" ] && echo yes || echo no)"

echo "== 2) 原型污染入口：PUT /windows 的 sceneId 只认 A/B"
chk "sceneId=__proto__ -> 400" "400" "$(st -X PUT "$B/api/rooms/$RID/windows" -H "x-api-key: $K" -H 'Content-Type: application/json' -d '{"sceneId":"__proto__","windows":[{"id":"evil","name":"evil"}]}')"
chk "sceneId=constructor -> 400" "400" "$(st -X PUT "$B/api/rooms/$RID/windows" -H "x-api-key: $K" -H 'Content-Type: application/json' -d '{"sceneId":"constructor","windows":[{"id":"evil","name":"evil"}]}')"
chk "sceneId=A 合法 -> 200" "200" "$(st -X PUT "$B/api/rooms/$RID/windows" -H "x-api-key: $K" -H 'Content-Type: application/json' -d '{"sceneId":"A","windows":[{"id":"w1","name":"w1","x":0,"y":0,"width":1920,"height":1080}]}')"

echo "== 3) PUT /rooms/:id 的 config：脏值 400 而不是挂起，合法值清洗后落库"
chk "config 非 JSON 字符串 -> 400" "400" "$(st -X PUT "$B/api/rooms/$RID" -H "x-api-key: $K" -H 'Content-Type: application/json' -d '{"config":"not-json{"}')"
chk "config 是数组 -> 400" "400" "$(st -X PUT "$B/api/rooms/$RID" -H "x-api-key: $K" -H 'Content-Type: application/json' -d '{"config":[1,2]}')"
chk "config 是数字 -> 400" "400" "$(st -X PUT "$B/api/rooms/$RID" -H "x-api-key: $K" -H 'Content-Type: application/json' -d '{"config":7}')"
chk "脏场景键+脏映射值 -> 200" "200" "$(st -X PUT "$B/api/rooms/$RID" -H "x-api-key: $K" -H 'Content-Type: application/json' \
  -d '{"config":{"scenes":{"A":{"name":"a","folder_mappings":{"01":"single-string","02":["good"],"toolongfoldername":["x"],"03":[],"04":["a","a",1,null,"b"]},"windows":[]},"__proto__":{"name":"evil","windows":[{"id":"evil"}]},"C":{"name":"c"}}}}')"
curl -s -m 8 "$B/api/rooms/$RID" -o /tmp/room.json
node -e "
const r=require('/tmp/room.json');
const cfg=typeof r.config==='string'?JSON.parse(r.config):r.config;
const sc=cfg.scenes||{};
const own=Object.keys(sc).sort().join(',');
const fm=(sc.A||{}).folder_mappings||{};
console.log('  OWN_SCENES='+own);
console.log('  A_MAPPINGS='+JSON.stringify(fm));
console.log('  A_WINDOWS='+JSON.stringify((sc.A||{}).windows));
console.log('  HAS_EVIL='+(JSON.stringify(cfg).indexOf('evil')>=0?'yes':'no'));
" > /tmp/cfg.report; cat /tmp/cfg.report
chk "scenes 只剩 A/B（脏键 __proto__/C 已丢弃，B 由骨架补出默认幕）" "A,B" "$(grep OWN_SCENES /tmp/cfg.report | sed 's/.*=//')"
chk "映射值归一：非法目录名/空数组剪掉，字符串转数组，非字符串 id 去杂" \
    '{"01":["single-string"],"02":["good"],"04":["a","b"]}' "$(grep A_MAPPINGS /tmp/cfg.report | sed 's/.*=//')"
chk "空 windows 不覆盖既有窗口（上一步 PUT 的 w1 还在）" '[{"id":"w1","name":"w1","x":0,"y":0,"width":1920,"height":1080}]' "$(grep A_WINDOWS /tmp/cfg.report | sed 's/.*=//')"
chk "evil 内容未落库" "no" "$(grep HAS_EVIL /tmp/cfg.report | sed 's/.*=//')"

echo "== 4) 素材删除接口：folder/scene 校验"
chk "folder=../../etc -> 400" "400" "$(st -X DELETE "$B/api/rooms/$RID/materials/m1?folder=../../etc" -H "x-api-key: $K")"
chk "scene=C -> 400" "400" "$(st -X DELETE "$B/api/rooms/$RID/materials/m1?folder=01&scene=C" -H "x-api-key: $K")"

echo "== 5) 授权/废止的存在性（不存在的设备；真实设备不发任何指令）"
chk "不存在设备授权 -> 404" "404" "$(st -X POST "$B/api/devices/zzbogusdevice/authorize?store=ZZROUND4&room_id=$RID" -H "x-api-key: $K")"
chk "不存在设备废止 -> 404" "404" "$(st -X POST "$B/api/devices/zzbogusdevice/deauthorize" -H "x-api-key: $K")"

echo "== 6) 文件夹备注校验"
LONG=$(node -e 'console.log("x".repeat(300))')
chk "备注超长 -> 400" "400" "$(st -X POST "$B/api/folders/note" -H "x-api-key: $K" -H 'Content-Type: application/json' -d "{\"folder\":\"zznote\",\"note\":\"$LONG\"}")"
chk "文件夹名非法 -> 400" "400" "$(st -X POST "$B/api/folders/note" -H "x-api-key: $K" -H 'Content-Type: application/json' -d '{"folder":"../evil","note":"x"}')"

echo "== 7) 真实房间快照比对"
curl -s -m 8 "$B/api/rooms" > /tmp/rooms-after.json
node -e "
const a=require('/tmp/rooms-before.json'), b=require('/tmp/rooms-after.json');
const cut=r=>r.filter(x=>!String(x.store_name).startsWith('ZZ')).map(x=>x.id+':'+x.name+':'+JSON.stringify(x.config)).sort().join('|');
console.log('  REAL_ROOMS_UNCHANGED='+(cut(a)===cut(b)));
"

echo "== 8) 清理临时数据"
chk "删除临时房间 -> 200" "200" "$(st -X DELETE "$B/api/rooms/$RID" -H "x-api-key: $K")"
chk "删除临时客户 -> 200" "200" "$(st -X DELETE "$B/api/stores/ZZROUND4" -H "x-api-key: $K")"
chk "房间数回到原值" "$(node -e "console.log(require('/tmp/rooms-before.json').length)")" \
    "$(curl -s -m 8 "$B/api/rooms" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).length))")"

echo "== 9) 进程健康：服务在跑 + 无未捕获异常"
systemctl is-active xvj
journalctl -u xvj --since "-5 min" --no-pager | grep -icE "uncaught|unhandled" | sed 's/^/  uncaught_lines=/'
echo
echo "结果: $pass 通过 / $fail 失败"
