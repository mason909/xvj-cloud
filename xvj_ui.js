// XVJ UI 公共组件

// 渲染素材卡片
function renderMaterialCard(m) {
    const thumb = m.thumbnail || m.url;
    const typeIcon = m.type === 'video' ? '🎬' : '🖼️';
    return `<div class="card" onclick="pv('${m.url}')">
        <img src="${thumb}" alt="${m.name}" onerror="this.style.display='none'">
        <div class="card-name">${typeIcon} ${m.name}</div>
        <button class="card-del" onclick="event.stopPropagation();rm('${m.id}')">×</button>
    </div>`;
}

// 渲染包厢卡片
function renderRoomCard(r) {
    const status = r.device_id 
        ? '<span class="customer-status on">已绑定</span>' 
        : '<span class="customer-status off">未绑定</span>';
    return `<div class="customer-card">
        <div class="device-header"><span>${r.name}</span>${status}</div>
        <div style="color:#888;font-size:12px">设备ID:${r.device_id||'无'}</div>
        <button class="btn btn-secondary" style="margin-top:10px" onclick="editRoom('${r.id}')">编辑</button>
        <button onclick="deleteRoom('${r.id}')" style="color:#e94560;margin-left:5px">删除</button>
    </div>`;
}

// 确认对话框
function confirm(msg) {
    return confirm(msg);
}

// 提示消息
function toast(msg) {
    alert(msg);
}

// 格式化日期
function formatDate(dateStr) {
    return new Date(dateStr).toLocaleDateString('zh-CN');
}
