// ============================================
// LinkManager - Cloudflare Workers
// KV绑定名称: LINK_MANAGER_KV
// 添加了使用统计和自动更新检测功能
// 增加了访问人数统计和IP日志记录
// 增加了链接状态失败时发送Telegram通知
// ============================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // KV 绑定
    const KV = env.LINK_MANAGER_KV;
    
    // 管理面板路由
    if (url.pathname === '/admin') {
      return handleAdminPanel(request, KV);
    }
    
    // 管理API路由
    if (url.pathname === '/admin/api/setup') {
      return handleAdminSetup(request, KV);
    }
    
    if (url.pathname === '/admin/api/login') {
      return handleAdminLogin(request, KV);
    }
    
    if (url.pathname === '/admin/api/update-config') {
      return handleUpdateConfig(request, KV);
    }
    
    if (url.pathname === '/admin/api/logout') {
      return handleAdminLogout(request, KV);
    }

    // 统计API路由
    if (url.pathname === '/api/stats') {
      return handleStats(request, KV);
    }
    
    // 测试Telegram通知
    if (url.pathname === '/admin/api/test-telegram') {
      return handleTestTelegram(request, KV);
    }
    
    // 从KV读取配置
    const CONFIG = await getConfigFromKV(KV);
    
    // API 端点：检查链接状态和更新时间
    if (url.pathname === '/api/check-link') {
      try {
        const response = await fetch(CONFIG.SUBSCRIPTION_URL, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000)
        });
        
        const isActive = response.ok || (response.status >= 200 && response.status < 400);
        
        // 从KV获取最后修改时间
        let lastModified = await KV.get('last_updated');
        if (!lastModified) {
          // 如果没有存储的时间，使用当前时间
          lastModified = convertToBeijingTime(new Date());
        }
        
        return new Response(JSON.stringify({ 
          active: isActive,
          status: response.status,
          lastModified: lastModified
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          active: false,
          error: error.message,
          lastModified: null
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }
    
    // 只统计主页访问
    if (url.pathname === '/') {
      await recordPageView(KV, request);
    }
    
    // 返回 HTML 页面
    return new Response(getHTML(CONFIG.SUBSCRIPTION_URL, CONFIG.TELEGRAM_GROUP), {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
      },
    });
  },

  // 定时任务 - 自动更新检测和统计清零
  async scheduled(controller, env, ctx) {
    const KV = env.LINK_MANAGER_KV;
    
    switch (controller.cron) {
      // 每5分钟检查链接状态
      case "*/5 * * * *":
        await checkAndUpdateLinkStatus(KV);
        break;
        
      // 每天UTC时间16:00（北京时间00:00）清零统计
      case "0 16 * * *":
        await resetDailyStats(KV);
        break;
    }
  },
};

// 发送Telegram通知
async function sendTelegramMessage(KV, message) {
  try {
    const botToken = await KV.get('telegram_bot_token');
    const chatId = await KV.get('telegram_chat_id');
    
    if (!botToken || !chatId) {
      console.log('Telegram配置不完整，无法发送通知');
      return false;
    }
    
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
    
    const result = await response.json();
    
    if (result.ok) {
      console.log('Telegram通知发送成功');
      return true;
    } else {
      console.error('Telegram通知发送失败:', result.description);
      return false;
    }
  } catch (error) {
    console.error('发送Telegram通知时出错:', error.message);
    return false;
  }
}

// 记录页面访问统计（包含IP记录和去重统计）
async function recordPageView(KV, request) {
  const today = getBeijingDateString();
  const lastResetDate = await KV.get('stats_reset_date');
  
  // 如果日期变化，自动重置统计
  if (lastResetDate !== today) {
    await resetDailyStats(KV);
  }
  
  // 获取客户端IP
  const clientIP = getClientIP(request);
  
  // 记录页面访问次数
  const pageViewsKey = 'daily_page_views';
  const currentPageViews = parseInt(await KV.get(pageViewsKey) || '0');
  await KV.put(pageViewsKey, (currentPageViews + 1).toString());
  
  // 记录访问IP日志
  await recordIPLog(KV, clientIP);
  
  // 记录去重访问人数
  await recordUniqueVisitor(KV, clientIP, today);
}

// 获取客户端IP
function getClientIP(request) {
  // 从 Cloudflare 头部获取真实客户端IP
  return request.headers.get('CF-Connecting-IP') || 
         request.headers.get('X-Forwarded-For') || 
         request.headers.get('X-Real-IP') || 
         'unknown';
}

// 记录IP访问日志
async function recordIPLog(KV, clientIP) {
  const timestamp = convertToBeijingTime(new Date());
  const logEntry = `${timestamp} - IP: ${clientIP}`;
  
  // 获取现有的日志（最多保留最近100条）
  const existingLogs = await KV.get('ip_access_logs');
  let logsArray = [];
  
  if (existingLogs) {
    logsArray = JSON.parse(existingLogs);
  }
  
  // 添加新日志条目
  logsArray.unshift(logEntry);
  
  // 限制日志数量为100条
  if (logsArray.length > 100) {
    logsArray = logsArray.slice(0, 100);
  }
  
  // 保存回KV
  await KV.put('ip_access_logs', JSON.stringify(logsArray));
}

// 记录去重访问人数
async function recordUniqueVisitor(KV, clientIP, today) {
  const uniqueVisitorsKey = `daily_unique_visitors_${today}`;
  
  // 获取今天的去重访问者集合
  const existingVisitors = await KV.get(uniqueVisitorsKey);
  let visitorsSet = new Set();
  
  if (existingVisitors) {
    visitorsSet = new Set(JSON.parse(existingVisitors));
  }
  
  // 添加当前IP
  visitorsSet.add(clientIP);
  
  // 保存回KV
  await KV.put(uniqueVisitorsKey, JSON.stringify(Array.from(visitorsSet)));
}

// 自动检查并更新链接状态（包含Telegram通知）
async function checkAndUpdateLinkStatus(KV) {
  try {
    const config = await getConfigFromKV(KV);
    if (!config.SUBSCRIPTION_URL || config.SUBSCRIPTION_URL === 'https://xx') {
      return;
    }
    
    const response = await fetch(config.SUBSCRIPTION_URL, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000)
    });
    
    const isActive = response.ok || (response.status >= 200 && response.status < 400);
    const previousStatus = await KV.get('auto_check_status');
    
    // 存储链接状态和检查时间
    await KV.put('auto_check_status', isActive ? 'active' : 'inactive');
    await KV.put('last_auto_check', convertToBeijingTime(new Date()));
    
    console.log(`自动检查完成: ${config.SUBSCRIPTION_URL} - 状态: ${isActive ? '正常' : '异常'}`);
    
    // 如果状态从正常变为异常，发送Telegram通知
    if (previousStatus === 'active' && !isActive) {
      const message = `🔴 <b>订阅链接异常</b>\n\n` +
                     `链接: ${config.SUBSCRIPTION_URL}\n` +
                     `状态: 连接失败\n` +
                     `时间: ${convertToBeijingTime(new Date())}\n` +
                     `请及时检查服务状态。`;
      
      await sendTelegramMessage(KV, message);
      console.log('已发送链接异常通知');
    }
    
    // 如果状态从异常恢复为正常，发送恢复通知
    if (previousStatus === 'inactive' && isActive) {
      const message = `🟢 <b>订阅链接已恢复</b>\n\n` +
                     `链接: ${config.SUBSCRIPTION_URL}\n` +
                     `状态: 连接正常\n` +
                     `时间: ${convertToBeijingTime(new Date())}\n` +
                     `服务已恢复正常。`;
      
      await sendTelegramMessage(KV, message);
      console.log('已发送链接恢复通知');
    }
    
  } catch (error) {
    const previousStatus = await KV.get('auto_check_status');
    
    await KV.put('auto_check_status', 'error');
    await KV.put('last_auto_check', convertToBeijingTime(new Date()));
    console.error('自动检查失败:', error.message);
    
    // 如果之前状态正常，发送检查失败通知
    if (previousStatus === 'active') {
      const config = await getConfigFromKV(KV);
      const message = `🔴 <b>订阅链接检查失败</b>\n\n` +
                     `链接: ${config.SUBSCRIPTION_URL}\n` +
                     `错误: ${error.message}\n` +
                     `时间: ${convertToBeijingTime(new Date())}\n` +
                     `请检查网络连接或服务状态。`;
      
      await sendTelegramMessage(KV, message);
      console.log('已发送检查失败通知');
    }
  }
}

// 重置每日统计
async function resetDailyStats(KV) {
  const today = getBeijingDateString();
  await KV.put('stats_reset_date', today);
  await KV.put('daily_page_views', '0');
  await KV.put('daily_copy_clicks', '0');
  await KV.put('daily_telegram_clicks', '0');
  
  // 不清除IP日志，只清除前一天的unique visitors
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = getBeijingDateString(yesterday);
  await KV.delete(`daily_unique_visitors_${yesterdayStr}`);
  
  console.log(`每日统计已重置: ${today}`);
}

// 记录统计信息（用于复制和TG点击）
async function recordStat(KV, statType) {
  const today = getBeijingDateString();
  const lastResetDate = await KV.get('stats_reset_date');
  
  // 如果日期变化，自动重置统计
  if (lastResetDate !== today) {
    await resetDailyStats(KV);
  }
  
  const statKey = `daily_${statType}`;
  const currentCount = parseInt(await KV.get(statKey) || '0');
  await KV.put(statKey, (currentCount + 1).toString());
}

// 获取统计信息
async function getStats(KV) {
  const today = getBeijingDateString();
  const lastResetDate = await KV.get('stats_reset_date');
  
  // 如果日期变化，自动重置统计
  if (lastResetDate !== today) {
    await resetDailyStats(KV);
  }
  
  // 获取去重访问人数
  const uniqueVisitorsKey = `daily_unique_visitors_${today}`;
  const uniqueVisitorsData = await KV.get(uniqueVisitorsKey);
  const uniqueVisitors = uniqueVisitorsData ? JSON.parse(uniqueVisitorsData).length : 0;
  
  // 获取IP访问日志
  const ipLogsData = await KV.get('ip_access_logs');
  const ipLogs = ipLogsData ? JSON.parse(ipLogsData) : [];
  
  // 获取Telegram配置状态
  const botToken = await KV.get('telegram_bot_token');
  const chatId = await KV.get('telegram_chat_id');
  const telegramConfigured = !!(botToken && chatId);
  
  return {
    page_views: parseInt(await KV.get('daily_page_views') || '0'),
    copy_clicks: parseInt(await KV.get('daily_copy_clicks') || '0'),
    telegram_clicks: parseInt(await KV.get('daily_telegram_clicks') || '0'),
    unique_visitors: uniqueVisitors,
    ip_logs: ipLogs,
    telegram_configured: telegramConfigured,
    reset_date: lastResetDate || today
  };
}

// 处理统计API
async function handleStats(request, KV) {
  if (request.method === 'POST') {
    // 记录事件
    const { type } = await request.json();
    if (['copy_clicks', 'telegram_clicks'].includes(type)) {
      await recordStat(KV, type);
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } else if (request.method === 'GET') {
    // 获取统计信息
    const stats = await getStats(KV);
    return new Response(JSON.stringify(stats), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  
  return new Response('Method not allowed', { status: 405 });
}

// 处理测试Telegram通知
async function handleTestTelegram(request, KV) {
  // 检查登录状态
  const cookieHeader = request.headers.get('Cookie');
  const isLoggedIn = cookieHeader && cookieHeader.includes('admin_authenticated=true');
  
  if (!isLoggedIn) {
    return new Response(JSON.stringify({ success: false, error: '未授权访问' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  
  try {
    const message = `🧪 <b>测试通知</b>\n\n` +
                   `这是一条测试消息，用于验证Telegram通知功能。\n` +
                   `时间: ${convertToBeijingTime(new Date())}\n` +
                   `如果收到此消息，说明配置正确！`;
    
    const success = await sendTelegramMessage(KV, message);
    
    if (success) {
      return new Response(JSON.stringify({ 
        success: true, 
        message: '测试消息发送成功，请检查Telegram'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      return new Response(JSON.stringify({ 
        success: false, 
        error: '发送失败，请检查Telegram配置'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 从KV获取配置
async function getConfigFromKV(KV) {
  const subscriptionUrl = await KV.get('subscription_url');
  const telegramGroup = await KV.get('telegram_group');
  const telegramBotToken = await KV.get('telegram_bot_token');
  const telegramChatId = await KV.get('telegram_chat_id');
  
  return {
    SUBSCRIPTION_URL: subscriptionUrl || 'https://xx',
    TELEGRAM_GROUP: telegramGroup || 'https://t.me',
    TELEGRAM_BOT_TOKEN: telegramBotToken || '',
    TELEGRAM_CHAT_ID: telegramChatId || ''
  };
}

// 获取北京日期字符串 (YYYY-MM-DD)
function getBeijingDateString(date = new Date()) {
  const beijingOffset = 8 * 60; // 北京时间 UTC+8
  const localOffset = date.getTimezoneOffset();
  const beijingTime = new Date(date.getTime() + (beijingOffset + localOffset) * 60000);
  
  return beijingTime.toISOString().split('T')[0];
}

// 转换为北京时间函数
function convertToBeijingTime(date) {
  const beijingOffset = 8 * 60; // 北京时间 UTC+8
  const localDate = new Date(date);
  const localOffset = localDate.getTimezoneOffset();
  const beijingTime = new Date(localDate.getTime() + (beijingOffset + localOffset) * 60000);
  
  return beijingTime.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

// 处理管理面板
async function handleAdminPanel(request, KV) {
  // 检查是否已设置密码
  const adminPassword = await KV.get('admin_password');
  
  if (!adminPassword) {
    // 显示初始设置页面
    return new Response(getSetupHTML(), {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
      },
    });
  }
  
  // 检查登录状态
  const cookieHeader = request.headers.get('Cookie');
  const isLoggedIn = cookieHeader && cookieHeader.includes('admin_authenticated=true');
  
  if (!isLoggedIn) {
    // 显示登录页面
    return new Response(getLoginHTML(), {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
      },
    });
  }
  
  // 显示管理面板
  const config = await getConfigFromKV(KV);
  const lastUpdated = await KV.get('last_updated') || '从未更新';
  const lastAutoCheck = await KV.get('last_auto_check') || '从未检查';
  const autoCheckStatus = await KV.get('auto_check_status') || 'unknown';
  const stats = await getStats(KV);
  
  return new Response(getAdminPanelHTML(config, lastUpdated, lastAutoCheck, autoCheckStatus, stats), {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
    },
  });
}

// 处理管理面板初始设置
async function handleAdminSetup(request, KV) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  
  try {
    const formData = await request.formData();
    const password = formData.get('password');
    
    if (!password) {
      return new Response(JSON.stringify({ success: false, error: '密码不能为空' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 存储密码
    await KV.put('admin_password', password);
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { 
        'Content-Type': 'application/json',
        'Set-Cookie': 'admin_authenticated=true; Path=/; HttpOnly; SameSite=Strict'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 处理管理员登录
async function handleAdminLogin(request, KV) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  
  try {
    const formData = await request.formData();
    const password = formData.get('password');
    const storedPassword = await KV.get('admin_password');
    
    if (!storedPassword) {
      return new Response(JSON.stringify({ success: false, error: '请先进行初始设置' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (password === storedPassword) {
      return new Response(JSON.stringify({ success: true }), {
        headers: { 
          'Content-Type': 'application/json',
          'Set-Cookie': 'admin_authenticated=true; Path=/; HttpOnly; SameSite=Strict'
        }
      });
    } else {
      return new Response(JSON.stringify({ success: false, error: '密码错误' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 处理管理员登出
async function handleAdminLogout(request, KV) {
  return new Response(JSON.stringify({ success: true }), {
    headers: { 
      'Content-Type': 'application/json',
      'Set-Cookie': 'admin_authenticated=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
    }
  });
}

// 处理配置更新
async function handleUpdateConfig(request, KV) {
  // 检查登录状态
  const cookieHeader = request.headers.get('Cookie');
  const isLoggedIn = cookieHeader && cookieHeader.includes('admin_authenticated=true');
  
  if (!isLoggedIn) {
    return new Response(JSON.stringify({ success: false, error: '未授权访问' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  
  try {
    const formData = await request.formData();
    const subscriptionUrl = formData.get('subscription_url');
    const telegramGroup = formData.get('telegram_group');
    const telegramBotToken = formData.get('telegram_bot_token');
    const telegramChatId = formData.get('telegram_chat_id');
    
    // 更新配置到KV
    await KV.put('subscription_url', subscriptionUrl);
    await KV.put('telegram_group', telegramGroup);
    await KV.put('telegram_bot_token', telegramBotToken);
    await KV.put('telegram_chat_id', telegramChatId);
    
    // 更新最后修改时间为当前北京时间
    const currentBeijingTime = convertToBeijingTime(new Date());
    await KV.put('last_updated', currentBeijingTime);
    
    return new Response(JSON.stringify({ 
      success: true, 
      message: '配置更新成功',
      lastUpdated: currentBeijingTime
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 初始设置页面HTML (保持不变)
function getSetupHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>初始设置 - Link Manager</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh; display: flex; justify-content: center; align-items: center;
            padding: 20px;
        }
        .card {
            background: white; border-radius: 20px; padding: 40px;
            width: 100%; max-width: 400px; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        h1 { text-align: center; margin-bottom: 30px; color: #333; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; color: #555; font-weight: 500; }
        input { width: 100%; padding: 12px; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 16px; }
        button { 
            width: 100%; padding: 14px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600;
            cursor: pointer; transition: transform 0.2s;
        }
        button:hover { transform: translateY(-2px); }
        .message { padding: 10px; border-radius: 8px; margin-bottom: 20px; text-align: center; display: none; }
        .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
    </style>
</head>
<body>
    <div class="card">
        <h1>初始设置</h1>
        <div id="message" class="message"></div>
        <form id="setupForm">
            <div class="form-group">
                <label for="password">设置管理密码</label>
                <input type="password" id="password" name="password" required placeholder="请输入管理密码">
            </div>
            <button type="submit">完成设置</button>
        </form>
    </div>
    <script>
        document.getElementById('setupForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            const formData = new FormData(this);
            const button = this.querySelector('button');
            const originalText = button.textContent;
            
            button.textContent = '设置中...';
            button.disabled = true;
            
            try {
                const response = await fetch('/admin/api/setup', {
                    method: 'POST',
                    body: formData
                });
                
                const result = await response.json();
                const message = document.getElementById('message');
                
                if (result.success) {
                    message.textContent = '设置成功！正在跳转...';
                    message.className = 'message success';
                    message.style.display = 'block';
                    setTimeout(() => window.location.href = '/admin', 1000);
                } else {
                    message.textContent = '错误：' + result.error;
                    message.className = 'message error';
                    message.style.display = 'block';
                }
            } catch (error) {
                const message = document.getElementById('message');
                message.textContent = '网络错误：' + error.message;
                message.className = 'message error';
                message.style.display = 'block';
            } finally {
                button.textContent = originalText;
                button.disabled = false;
            }
        });
    </script>
</body>
</html>`;
}

// 登录页面HTML (保持不变)
function getLoginHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录 - Link Manager</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh; display: flex; justify-content: center; align-items: center;
            padding: 20px;
        }
        .card {
            background: white; border-radius: 20px; padding: 40px;
            width: 100%; max-width: 400px; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        h1 { text-align: center; margin-bottom: 30px; color: #333; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; color: #555; font-weight: 500; }
        input { width: 100%; padding: 12px; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 16px; }
        button { 
            width: 100%; padding: 14px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600;
            cursor: pointer; transition: transform 0.2s;
        }
        button:hover { transform: translateY(-2px); }
        .message { padding: 10px; border-radius: 8px; margin-bottom: 20px; text-align: center; display: none; }
        .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
    </style>
</head>
<body>
    <div class="card">
        <h1>管理员登录</h1>
        <div id="message" class="message"></div>
        <form id="loginForm">
            <div class="form-group">
                <label for="password">管理密码</label>
                <input type="password" id="password" name="password" required placeholder="请输入管理密码">
            </div>
            <button type="submit">登录</button>
        </form>
    </div>
    <script>
        document.getElementById('loginForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            const formData = new FormData(this);
            const button = this.querySelector('button');
            const originalText = button.textContent;
            
            button.textContent = '登录中...';
            button.disabled = true;
            
            try {
                const response = await fetch('/admin/api/login', {
                    method: 'POST',
                    body: formData
                });
                
                const result = await response.json();
                const message = document.getElementById('message');
                
                if (result.success) {
                    window.location.href = '/admin';
                } else {
                    message.textContent = result.error;
                    message.className = 'message error';
                    message.style.display = 'block';
                }
            } catch (error) {
                const message = document.getElementById('message');
                message.textContent = '网络错误：' + error.message;
                message.className = 'message error';
                message.style.display = 'block';
            } finally {
                button.textContent = originalText;
                button.disabled = false;
            }
        });
    </script>
</body>
</html>`;
}

// 管理面板HTML (增强版，添加Telegram通知配置)
function getAdminPanelHTML(config, lastUpdated, lastAutoCheck, autoCheckStatus, stats) {
  const statusText = {
    'active': '正常',
    'inactive': '异常',
    'error': '检查失败',
    'unknown': '未知'
  }[autoCheckStatus] || '未知';
  
  const statusColor = {
    'active': '#10b981',
    'inactive': '#ef4444',
    'error': '#f59e0b',
    'unknown': '#6b7280'
  }[autoCheckStatus] || '#6b7280';

  // Telegram配置状态
  const telegramStatus = stats.telegram_configured ? 
    '<span style="color: #10b981;">✓ 已配置</span>' : 
    '<span style="color: #ef4444;">✗ 未配置</span>';

  // 构建IP日志HTML
  const ipLogsHTML = stats.ip_logs && stats.ip_logs.length > 0 
    ? stats.ip_logs.map(log => `<div style="padding: 5px 0; border-bottom: 1px solid #eee; font-family: monospace; font-size: 12px;">${log}</div>`).join('')
    : '<div style="padding: 10px; text-align: center; color: #999;">暂无访问日志</div>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>管理面板 - Link Manager</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f5f5; min-height: 100vh; padding: 20px;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { 
            background: white; padding: 30px; border-radius: 15px; 
            box-shadow: 0 5px 15px rgba(0,0,0,0.1); margin-bottom: 20px;
            text-align: center; display: flex; justify-content: space-between; align-items: center;
        }
        .card {
            background: white; padding: 30px; border-radius: 15px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1); margin-bottom: 20px;
        }
        h1 { color: #333; margin-bottom: 10px; }
        h2 { color: #333; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 2px solid #f0f0f0; }
        h3 { color: #555; margin-bottom: 15px; }
        .subtitle { color: #666; margin-bottom: 20px; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; color: #555; font-weight: 500; }
        input { width: 100%; padding: 12px; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 16px; }
        button { 
            padding: 14px 30px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600;
            cursor: pointer; transition: transform 0.2s; margin-right: 10px; margin-bottom: 10px;
        }
        button:hover { transform: translateY(-2px); }
        .button-secondary {
            background: #6c757d;
        }
        .button-success {
            background: #10b981;
        }
        .button-warning {
            background: #f59e0b;
        }
        .message { padding: 15px; border-radius: 8px; margin-bottom: 20px; display: none; }
        .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        .info-box { 
            background: #e3f2fd; padding: 15px; border-radius: 8px; 
            border-left: 4px solid #2196f3; margin-bottom: 20px;
        }
        .stats-grid { 
            display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
            gap: 15px; margin-bottom: 20px;
        }
        .stat-card {
            background: white; padding: 20px; border-radius: 10px;
            border-left: 4px solid #667eea; box-shadow: 0 2px 5px rgba(0,0,0,0.1);
            text-align: center;
        }
        .stat-number { 
            font-size: 2rem; font-weight: bold; color: #333; 
            margin-bottom: 5px;
        }
        .stat-label { 
            color: #666; font-size: 0.9rem;
        }
        .status-badge {
            display: inline-block; padding: 5px 12px; border-radius: 20px;
            color: white; font-size: 0.8rem; font-weight: 500;
        }
        .logs-container {
            max-height: 400px; overflow-y: auto; border: 1px solid #e2e8f0;
            border-radius: 8px; padding: 15px; background: #fafafa;
            margin-top: 15px;
        }
        .two-column {
            display: grid; grid-template-columns: 1fr 1fr; gap: 20px;
        }
        .help-text {
            color: #6b7280; font-size: 0.875rem; margin-top: 5px;
        }
        @media (max-width: 768px) {
            .two-column { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Link Manager</h1>
                <p class="subtitle">配置您的订阅服务</p>
            </div>
            <div>
                <button onclick="logout()" class="button-secondary">退出登录</button>
            </div>
        </div>
        
        <div class="two-column">
            <!-- 左侧：统计信息和配置 -->
            <div>
                <!-- 统计信息卡片 -->
                <div class="card">
                    <h2>今日统计</h2>
                    <div class="stats-grid">
                        <div class="stat-card">
                            <div class="stat-number">${stats.page_views}</div>
                            <div class="stat-label">页面访问</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-number">${stats.unique_visitors}</div>
                            <div class="stat-label">访问人数</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-number">${stats.copy_clicks}</div>
                            <div class="stat-label">复制次数</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-number">${stats.telegram_clicks}</div>
                            <div class="stat-label">TG点击</div>
                        </div>
                    </div>
                    <div class="info-box">
                        <strong>统计重置日期:</strong> ${stats.reset_date} (每日北京时间 00:00 自动重置)<br>
                        <strong>注意:</strong> 页面访问统计主页访问，访问人数基于IP去重
                    </div>
                </div>
                
                <!-- 配置表单 -->
                <div class="card">
                    <h2>配置管理</h2>
                    <div id="message" class="message"></div>
                    
                    <div class="info-box">
                        <strong>最后配置更新时间:</strong> ${lastUpdated}<br>
                        <strong>最后自动检查时间:</strong> ${lastAutoCheck}<br>
                        <strong>自动检查状态:</strong> 
                        <span class="status-badge" style="background: ${statusColor}">${statusText}</span><br>
                        <strong>Telegram通知:</strong> ${telegramStatus}
                    </div>
                    
                    <form id="configForm">
                        <h3>基本配置</h3>
                        <div class="form-group">
                            <label for="subscription_url">订阅链接 (SUBSCRIPTION_URL)</label>
                            <input type="url" id="subscription_url" name="subscription_url" 
                                   value="${config.SUBSCRIPTION_URL}" required 
                                   placeholder="https://snippets.vlato.site">
                        </div>
                        
                        <div class="form-group">
                            <label for="telegram_group">Telegram群组链接 (TELEGRAM_GROUP)</label>
                            <input type="url" id="telegram_group" name="telegram_group" 
                                   value="${config.TELEGRAM_GROUP}" required 
                                   placeholder="https://t.me/your_group">
                        </div>
                        
                        <h3>Telegram通知配置</h3>
                        <div class="form-group">
                            <label for="telegram_bot_token">Telegram Bot Token</label>
                            <input type="text" id="telegram_bot_token" name="telegram_bot_token" 
                                   value="${config.TELEGRAM_BOT_TOKEN}" 
                                   placeholder="1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ">
                            <div class="help-text">
                                通过 @BotFather 创建机器人获取Token
                            </div>
                        </div>
                        
                        <div class="form-group">
                            <label for="telegram_chat_id">Telegram Chat ID</label>
                            <input type="text" id="telegram_chat_id" name="telegram_chat_id" 
                                   value="${config.TELEGRAM_CHAT_ID}" 
                                   placeholder="123456789">
                            <div class="help-text">
                                您的用户ID或群组ID，可通过 @userinfobot 获取
                            </div>
                        </div>
                        
                        <button type="submit">更新配置</button>
                        <button type="button" onclick="testTelegram()" class="button-success">测试通知</button>
                        <button type="button" onclick="window.location.href='/'">返回主页</button>
                    </form>
                </div>
            </div>
            
            <!-- 右侧：访问日志 -->
            <div>
                <div class="card">
                    <h2>访问IP日志 (最近100条)</h2>
                    <div class="logs-container">
                        ${ipLogsHTML}
                    </div>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        document.getElementById('configForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            const formData = new FormData(this);
            const button = this.querySelector('button[type="submit"]');
            const originalText = button.textContent;
            
            button.textContent = '更新中...';
            button.disabled = true;
            
            try {
                const response = await fetch('/admin/api/update-config', {
                    method: 'POST',
                    body: formData
                });
                
                const result = await response.json();
                const message = document.getElementById('message');
                
                if (result.success) {
                    message.textContent = result.message + ' 最后更新: ' + result.lastUpdated;
                    message.className = 'message success';
                    message.style.display = 'block';
                    // 刷新页面以更新统计信息
                    setTimeout(() => location.reload(), 2000);
                } else {
                    message.textContent = '错误：' + result.error;
                    message.className = 'message error';
                    message.style.display = 'block';
                }
            } catch (error) {
                const message = document.getElementById('message');
                message.textContent = '网络错误：' + error.message;
                message.className = 'message error';
                message.style.display = 'block';
            } finally {
                button.textContent = originalText;
                button.disabled = false;
            }
        });
        
        async function testTelegram() {
            const button = document.querySelector('button.button-success');
            const originalText = button.textContent;
            
            button.textContent = '发送中...';
            button.disabled = true;
            
            try {
                const response = await fetch('/admin/api/test-telegram', {
                    method: 'POST'
                });
                
                const result = await response.json();
                const message = document.getElementById('message');
                
                if (result.success) {
                    message.textContent = result.message;
                    message.className = 'message success';
                    message.style.display = 'block';
                } else {
                    message.textContent = '错误：' + result.error;
                    message.className = 'message error';
                    message.style.display = 'block';
                }
            } catch (error) {
                const message = document.getElementById('message');
                message.textContent = '网络错误：' + error.message;
                message.className = 'message error';
                message.style.display = 'block';
            } finally {
                button.textContent = originalText;
                button.disabled = false;
            }
        }
        
        async function logout() {
            await fetch('/admin/api/logout');
            window.location.href = '/admin';
        }
    </script>
</body>
</html>`;
}

// 主页面HTML (保持不变)
function getHTML(subscriptionUrl, telegramGroup) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hello Snippets!</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }

        .card {
            background: #f5f5f5;
            border-radius: 20px;
            padding: 50px 40px;
            width: 100%;
            max-width: 420px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            text-align: center;
        }

        .icon {
            width: 70px;
            height: 70px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 16px;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0 auto 30px;
            box-shadow: 0 8px 16px rgba(102, 126, 234, 0.4);
        }

        .icon svg {
            width: 36px;
            height: 36px;
            fill: white;
        }

        h1 {
            font-size: 32px;
            font-weight: 700;
            color: #2d3748;
            margin-bottom: 30px;
        }

        .status {
            color: white;
            padding: 10px 24px;
            border-radius: 25px;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
            font-weight: 500;
            margin-bottom: 12px;
            transition: all 0.3s ease;
        }

        .status.active {
            background: #10b981;
        }

        .status.inactive {
            background: #ef4444;
        }

        .status.checking {
            background: #f59e0b;
        }

        .status::before {
            font-size: 16px;
            font-weight: bold;
        }

        .status.active::before {
            content: "✓";
        }

        .status.inactive::before {
            content: "✗";
        }

        .status.checking::before {
            content: "⟳";
            animation: rotate 1s linear infinite;
        }

        .update-time {
            color: #718096;
            font-size: 12px;
            margin-bottom: 30px;
            background: rgba(255, 255, 255, 0.7);
            padding: 6px 12px;
            border-radius: 12px;
            display: inline-block;
        }

        @keyframes rotate {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }

        .description {
            color: #718096;
            font-size: 14px;
            margin-bottom: 15px;
            line-height: 1.6;
        }

        .button {
            width: 100%;
            padding: 16px 24px;
            border: none;
            border-radius: 12px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            margin-bottom: 12px;
            text-decoration: none;
            color: white;
            position: relative;
            overflow: hidden;
        }

        .button-purple {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }

        .button-purple:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 16px rgba(102, 126, 234, 0.4);
        }

        .button-cyan {
            background: linear-gradient(135deg, #0891b2 0%, #06b6d4 100%);
        }

        .button-cyan:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 16px rgba(8, 145, 178, 0.4);
        }

        .button-copied {
            background: linear-gradient(135deg, #10b981 0%, #059669 100%) !important;
            transform: scale(0.98);
        }

        .button::before {
            font-size: 18px;
        }

        .button-purple::before {
            content: "📄";
        }

        .button-cyan::before {
            content: "✈";
        }

        .footer {
            margin-top: 40px;
            color: #a0aec0;
            font-size: 13px;
        }

        .copy-feedback {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(16, 185, 129, 0.9);
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.3s ease;
        }

        .copy-feedback.show {
            opacity: 1;
        }
        
        .admin-link {
            display: inline-block;
            margin-top: 15px;
            color: #667eea;
            text-decoration: none;
            font-size: 13px;
        }
        
        .admin-link:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z"/>
            </svg>
        </div>
        
        <h1>Hello Snippets!</h1>
        
        <div id="statusBadge" class="status checking">正在检测...</div>
        
        <p class="description">
            您的代理服务正在正常运行,享受安全、快速的网络连接体验
        </p>
        
        <div id="updateTime" class="update-time">检测更新时间...</div>
        
        <button id="copyButton" class="button button-purple">
            <span>订阅链接（点击复制）</span>
            <div id="copyFeedback" class="copy-feedback">
                <span>已复制！</span>
            </div>
        </button>
        
        <a href="${telegramGroup}" target="_blank" id="tgButton" class="button button-cyan">
            加入TG交流群组
        </a>
        
        <a href="/admin" class="admin-link">管理面板</a>
        
        <div class="footer">
            Powered by Cloudflare
        </div>
    </div>

    <script>
        const subscriptionUrl = "${subscriptionUrl}";
        const copyButton = document.getElementById('copyButton');
        const copyFeedback = document.getElementById('copyFeedback');
        const tgButton = document.getElementById('tgButton');

        // 上报统计事件
        async function recordStat(type) {
            try {
                await fetch('/api/stats', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ type: type })
                });
            } catch (error) {
                // 静默失败，不影响用户体验
                console.log('统计上报失败:', error);
            }
        }

        async function checkLinkStatus() {
            const statusBadge = document.getElementById('statusBadge');
            const updateTime = document.getElementById('updateTime');
            
            try {
                const response = await fetch('/api/check-link');
                const data = await response.json();
                
                if (data.active) {
                    statusBadge.className = 'status active';
                    statusBadge.textContent = '代理功能已启用';
                    
                    if (data.lastModified) {
                        updateTime.textContent = '最后更新: ' + data.lastModified;
                    } else {
                        updateTime.textContent = '最后更新: 未知';
                    }
                } else {
                    statusBadge.className = 'status inactive';
                    statusBadge.textContent = '代理功能已失效';
                    updateTime.textContent = '更新检测失败';
                }
            } catch (error) {
                console.error('检测失败:', error);
                statusBadge.className = 'status inactive';
                statusBadge.textContent = '代理功能已失效';
                updateTime.textContent = '更新检测失败';
            }
        }

        function copyToClipboard() {
            navigator.clipboard.writeText(subscriptionUrl).then(function() {
                // 显示复制成功效果
                copyButton.classList.add('button-copied');
                copyFeedback.classList.add('show');
                
                // 记录复制统计
                recordStat('copy_clicks');
                
                // 3秒后恢复原状
                setTimeout(function() {
                    copyButton.classList.remove('button-copied');
                    copyFeedback.classList.remove('show');
                }, 3000);
            }).catch(function(err) {
                console.error('复制失败:', err);
                // 复制失败也显示效果，但用红色
                copyButton.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
                copyButton.querySelector('span').textContent = '复制失败';
                
                setTimeout(function() {
                    copyButton.style.background = '';
                    copyButton.querySelector('span').textContent = '订阅链接（点击复制）';
                }, 3000);
            });
        }

        // 绑定复制按钮点击事件
        copyButton.addEventListener('click', copyToClipboard);

        // 绑定TG按钮点击事件
        tgButton.addEventListener('click', function() {
            recordStat('telegram_clicks');
        });

        window.addEventListener('DOMContentLoaded', checkLinkStatus);
    </script>
</body>
</html>`;
}