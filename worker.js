// ============================================
// LinkManager - Cloudflare Workers
// KV绑定名称: LINK_MANAGER_KV
// ============================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const KV = env.LINK_MANAGER_KV;

    // 路由处理
    const routes = {
      '/admin': () => handleAdminPanel(request, KV),
      '/admin/api/setup': () => handleAdminSetup(request, KV),
      '/admin/api/login': () => handleAdminLogin(request, KV),
      '/admin/api/update-config': () => handleUpdateConfig(request, KV),
      '/admin/api/logout': () => handleAdminLogout(request, KV),
      '/api/stats': () => handleStats(request, KV),
      '/admin/api/test-telegram': () => handleTestTelegram(request, KV),
      '/api/check-link': async () => {
        const CONFIG = await getConfigFromKV(KV);
        return handleCheckLink(CONFIG, KV);
      }
    };

    // 执行路由处理
    const routeHandler = routes[url.pathname];
    if (routeHandler) {
      return await routeHandler();
    }

    // 主页访问统计
    if (url.pathname === '/') {
      await recordPageView(KV, request);
    }

    // 返回主页
    const CONFIG = await getConfigFromKV(KV);
    return new Response(getHTML(CONFIG.SUBSCRIPTION_URL, CONFIG.TELEGRAM_GROUP), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  },

  async scheduled(controller, env, ctx) {
    const KV = env.LINK_MANAGER_KV;
    const now = new Date();
    const beijingTime = convertToBeijingTime(now);
    const beijingHours = new Date(beijingTime).getHours();
    const beijingMinutes = new Date(beijingTime).getMinutes();

    console.log(`定时任务执行: ${beijingTime}, 小时: ${beijingHours}, 分钟: ${beijingMinutes}`);

    const cronLogs = [
      `🕒 <b>定时任务执行报告</b>`,
      `执行时间: ${beijingTime}`
    ];

    // 每5分钟检查链接状态
    const linkCheckResult = await checkAndUpdateLinkStatus(KV);
    cronLogs.push(linkCheckResult);

    // 每天北京时间00:00重置统计
    let resetResult = '';
    if (beijingHours === 0 && beijingMinutes === 0) {
      resetResult = await resetDailyStats(KV);
      cronLogs.push(resetResult);
      
      const clearIPLogsResult = await clearIPLogs(KV);
      cronLogs.push(clearIPLogsResult);
    } else {
      resetResult = '跳过每日统计重置，当前不是北京时间00:00';
      cronLogs.push(resetResult);
    }

    // 统计摘要
    const stats = await getStats(KV);
    cronLogs.push(
      `\n<b>📊 今日统计摘要</b>`,
      `页面访问: ${stats.page_views} 次`,
      `独立访客: ${stats.unique_visitors} 人`,
      `复制次数: ${stats.copy_clicks} 次`,
      `TG点击: ${stats.telegram_clicks} 次`
    );

    // 检查是否启用定时任务报告
    const cronReportEnabled = await KV.get('cron_report_enabled');
    if (cronReportEnabled !== 'false') {
      await sendCronReportToTelegram(KV, cronLogs);
    } else {
      console.log('定时任务报告已禁用，跳过发送');
    }
  }
};

// ==================== 工具函数 ====================

// 清空IP日志
async function clearIPLogs(KV) {
  try {
    await KV.put('ip_access_logs', JSON.stringify([]));
    return '🗑️ IP访问日志已清空';
  } catch (error) {
    return '❌ IP日志清空失败: ' + error.message;
  }
}

// 发送定时任务报告到Telegram
async function sendCronReportToTelegram(KV, logs) {
  try {
    const message = logs.join('\n');
    return await sendTelegramMessage(KV, message);
  } catch (error) {
    console.error('发送定时任务报告时出错:', error.message);
    return false;
  }
}

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
    
    const result = await response.json();
    return result.ok;
  } catch (error) {
    console.error('发送Telegram通知时出错:', error.message);
    return false;
  }
}

// 检查是否为忽略的IP地址
async function isIgnoredIP(KV, ip) {
  try {
    const ignoredIP = await KV.get('ignored_ip');
    if (!ignoredIP) return false;
    
    const normalizeIP = (ip) => {
      if (!ip) return '';
      ip = ip.trim().toLowerCase();
      
      if (ip.includes(':')) {
        try {
          const parts = ip.split(':');
          let expandedParts = [];
          let foundEmpty = false;
          
          for (let i = 0; i < parts.length; i++) {
            if (parts[i] === '') {
              if (!foundEmpty) {
                const zeroCount = 8 - (parts.length - 1);
                for (let j = 0; j < zeroCount; j++) {
                  expandedParts.push('0000');
                }
                foundEmpty = true;
              }
            } else {
              expandedParts.push(parts[i].padStart(4, '0'));
            }
          }
          
          if (!foundEmpty && expandedParts.length < 8) {
            while (expandedParts.length < 8) {
              expandedParts.push('0000');
            }
          }
          
          return expandedParts.join(':');
        } catch (e) {
          return ip;
        }
      }
      
      return ip;
    };
    
    return normalizeIP(ignoredIP) === normalizeIP(ip);
  } catch (error) {
    return false;
  }
}

// 记录页面访问统计
async function recordPageView(KV, request) {
  const today = getBeijingDateString();
  const lastResetDate = await KV.get('stats_reset_date');
  
  if (lastResetDate !== today) {
    await resetDailyStats(KV);
  }
  
  const clientInfo = getClientInfo(request);
  const shouldIgnore = await isIgnoredIP(KV, clientInfo.ip);
  
  if (shouldIgnore) {
    console.log(`✅ 忽略IP ${clientInfo.ip} 的访问数据`);
    return;
  }
  
  // 记录页面访问次数
  const pageViewsKey = 'daily_page_views';
  const currentPageViews = parseInt(await KV.get(pageViewsKey) || '0');
  await KV.put(pageViewsKey, (currentPageViews + 1).toString());
  
  // 记录访问日志和独立访客
  await recordIPLog(KV, clientInfo);
  await recordUniqueVisitor(KV, clientInfo.ip, today);
}

// 获取客户端信息
function getClientInfo(request) {
  const clientIP = request.headers.get('CF-Connecting-IP') || 
                   request.headers.get('X-Forwarded-For') || 
                   request.headers.get('X-Real-IP') || 
                   'unknown';
  
  const country = request.cf?.country || '未知';
  const city = request.cf?.city || '未知';
  const region = request.cf?.region || '未知';
  const asn = request.cf?.asn || '未知';
  const asOrganization = request.cf?.asOrganization || '未知';
  
  return {
    ip: clientIP,
    country: country,
    city: city,
    region: region,
    asn: asn,
    isp: asOrganization !== '未知' ? asOrganization : '未知'
  };
}

// 记录IP访问日志
async function recordIPLog(KV, clientInfo) {
  const timestamp = convertToBeijingTime(new Date());
  const logEntry = `${timestamp}\n` +
                  `IP 地址: ${clientInfo.ip}\n` +
                  `国家: ${clientInfo.country}\n` +
                  `城市: ${clientInfo.city}\n` +
                  `ISP: ${clientInfo.isp}\n` +
                  `ASN: ${clientInfo.asn}`;
  
  await saveIPLogToKV(KV, logEntry);
}

// 保存IP日志到KV
async function saveIPLogToKV(KV, logEntry) {
  const existingLogs = await KV.get('ip_access_logs');
  let logsArray = existingLogs ? JSON.parse(existingLogs) : [];
  
  logsArray.unshift(logEntry);
  if (logsArray.length > 100) {
    logsArray = logsArray.slice(0, 100);
  }
  
  await KV.put('ip_access_logs', JSON.stringify(logsArray));
}

// 记录独立访客
async function recordUniqueVisitor(KV, clientIP, today) {
  const shouldIgnore = await isIgnoredIP(KV, clientIP);
  if (shouldIgnore) return;

  const uniqueVisitorsKey = `daily_unique_visitors_${today}`;
  const existingVisitors = await KV.get(uniqueVisitorsKey);
  let visitorsSet = existingVisitors ? new Set(JSON.parse(existingVisitors)) : new Set();
  
  visitorsSet.add(clientIP);
  await KV.put(uniqueVisitorsKey, JSON.stringify(Array.from(visitorsSet)));
}

// 检查链接状态
async function checkAndUpdateLinkStatus(KV) {
  try {
    const config = await getConfigFromKV(KV);
    if (!config.SUBSCRIPTION_URL || config.SUBSCRIPTION_URL === 'https://xx') {
      return '❌ 订阅链接未配置，跳过自动检查';
    }
    
    const response = await fetch(config.SUBSCRIPTION_URL, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000)
    });
    
    const isActive = response.ok || (response.status >= 200 && response.status < 400);
    const previousStatus = await KV.get('auto_check_status');
    
    await KV.put('auto_check_status', isActive ? 'active' : 'inactive');
    await KV.put('last_auto_check', convertToBeijingTime(new Date()));
    
    const statusText = isActive ? '正常' : '异常';
    let result = `✅ 链接检查完成: ${statusText}`;
    
    // 状态变化通知 - 这些通知不受定时任务报告开关影响
    if (previousStatus === 'active' && !isActive) {
      const message = `🔴 <b>订阅链接异常</b>\n\n` +
                     `链接: ${config.SUBSCRIPTION_URL}\n` +
                     `状态: 连接失败\n` +
                     `时间: ${convertToBeijingTime(new Date())}\n` +
                     `请及时检查服务状态。`;
      
      await sendTelegramMessage(KV, message);
      result += ' 🔴 (已发送异常通知)';
    }
    
    if (previousStatus === 'inactive' && isActive) {
      const message = `🟢 <b>订阅链接已恢复</b>\n\n` +
                     `链接: ${config.SUBSCRIPTION_URL}\n` +
                     `状态: 连接正常\n` +
                     `时间: ${convertToBeijingTime(new Date())}\n` +
                     `服务已恢复正常。`;
      
      await sendTelegramMessage(KV, message);
      result += ' 🟢 (已发送恢复通知)';
    }
    
    return result;
    
  } catch (error) {
    const previousStatus = await KV.get('auto_check_status');
    await KV.put('auto_check_status', 'error');
    await KV.put('last_auto_check', convertToBeijingTime(new Date()));
    
    let result = `❌ 链接检查失败: ${error.message}`;
    
    if (previousStatus === 'active') {
      const config = await getConfigFromKV(KV);
      const message = `🔴 <b>订阅链接检查失败</b>\n\n` +
                     `链接: ${config.SUBSCRIPTION_URL}\n` +
                     `错误: ${error.message}\n` +
                     `时间: ${convertToBeijingTime(new Date())}\n` +
                     `请检查网络连接或服务状态。`;
      
      await sendTelegramMessage(KV, message);
      result += ' 🔴 (已发送失败通知)';
    }
    
    return result;
  }
}

// 处理链接检查API
async function handleCheckLink(CONFIG, KV) {
  try {
    const response = await fetch(CONFIG.SUBSCRIPTION_URL, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000)
    });
    
    const isActive = response.ok || (response.status >= 200 && response.status < 400);
    let lastModified = await KV.get('last_updated');
    
    if (!lastModified) {
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

// 重置每日统计
async function resetDailyStats(KV) {
  try {
    const today = getBeijingDateString();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = getBeijingDateString(yesterday);
    
    // 获取昨日统计
    const yesterdayPageViews = parseInt(await KV.get('daily_page_views') || '0');
    const yesterdayCopyClicks = parseInt(await KV.get('daily_copy_clicks') || '0');
    const yesterdayTelegramClicks = parseInt(await KV.get('daily_telegram_clicks') || '0');
    
    const yesterdayVisitorsKey = `daily_unique_visitors_${yesterdayStr}`;
    const yesterdayVisitorsData = await KV.get(yesterdayVisitorsKey);
    const yesterdayUniqueVisitors = yesterdayVisitorsData ? JSON.parse(yesterdayVisitorsData).length : 0;
    
    // 执行重置
    await KV.put('stats_reset_date', today);
    await KV.put('daily_page_views', '0');
    await KV.put('daily_copy_clicks', '0');
    await KV.put('daily_telegram_clicks', '0');
    
    // 删除前一天的IP集合
    await KV.delete(yesterdayVisitorsKey);
    await KV.delete(`daily_copy_clicks_ips_${yesterdayStr}`);
    await KV.delete(`daily_telegram_clicks_ips_${yesterdayStr}`);
    
    let result = `🔄 <b>每日统计已重置</b>\n\n`;
    result += `重置时间: ${today}\n\n`;
    result += `<b>昨日统计摘要:</b>\n`;
    result += `页面访问: ${yesterdayPageViews} 次\n`;
    result += `独立访客: ${yesterdayUniqueVisitors} 人\n`;
    result += `复制次数: ${yesterdayCopyClicks} 次\n`;
    result += `TG点击: ${yesterdayTelegramClicks} 次`;
    
    return result;
    
  } catch (error) {
    return `❌ 统计重置失败: ${error.message}`;
  }
}

// 记录统计事件（支持IP去重）
async function recordStat(KV, statType, clientIP) {
  const today = getBeijingDateString();
  const lastResetDate = await KV.get('stats_reset_date');
  
  if (lastResetDate !== today) {
    await resetDailyStats(KV);
  }
  
  const shouldIgnore = await isIgnoredIP(KV, clientIP);
  if (shouldIgnore) {
    console.log(`✅ 忽略IP ${clientIP} 的${statType}统计`);
    return;
  }
  
  // 检查IP是否已经记录过该事件
  const ipSetKey = `daily_${statType}_ips_${today}`;
  const existingIPs = await KV.get(ipSetKey);
  let ipSet = existingIPs ? new Set(JSON.parse(existingIPs)) : new Set();
  
  // 如果IP已经存在，跳过记录
  if (ipSet.has(clientIP)) {
    console.log(`✅ IP ${clientIP} 今天已经记录过${statType}，跳过`);
    return;
  }
  
  // 记录IP并更新统计
  ipSet.add(clientIP);
  await KV.put(ipSetKey, JSON.stringify(Array.from(ipSet)));
  
  const statKey = `daily_${statType}`;
  const currentCount = parseInt(await KV.get(statKey) || '0');
  await KV.put(statKey, (currentCount + 1).toString());
  
  console.log(`✅ 记录${statType}，IP: ${clientIP}，新计数: ${currentCount + 1}`);
}

// 获取统计信息
async function getStats(KV) {
  const today = getBeijingDateString();
  const lastResetDate = await KV.get('stats_reset_date');
  
  if (lastResetDate !== today) {
    await resetDailyStats(KV);
  }
  
  const uniqueVisitorsKey = `daily_unique_visitors_${today}`;
  const uniqueVisitorsData = await KV.get(uniqueVisitorsKey);
  const uniqueVisitors = uniqueVisitorsData ? JSON.parse(uniqueVisitorsData).length : 0;
  
  const ipLogsData = await KV.get('ip_access_logs');
  const ipLogs = ipLogsData ? JSON.parse(ipLogsData) : [];
  
  const botToken = await KV.get('telegram_bot_token');
  const chatId = await KV.get('telegram_chat_id');
  const ignoredIP = await KV.get('ignored_ip') || '未设置';
  const cronReportEnabled = await KV.get('cron_report_enabled');
  
  return {
    page_views: parseInt(await KV.get('daily_page_views') || '0'),
    copy_clicks: parseInt(await KV.get('daily_copy_clicks') || '0'),
    telegram_clicks: parseInt(await KV.get('daily_telegram_clicks') || '0'),
    unique_visitors: uniqueVisitors,
    ip_logs: ipLogs,
    telegram_configured: !!(botToken && chatId),
    ignored_ip: ignoredIP,
    cron_report_enabled: cronReportEnabled !== 'false',
    reset_date: lastResetDate || today
  };
}

// 处理统计API
async function handleStats(request, KV) {
  if (request.method === 'POST') {
    try {
      const { type } = await request.json();
      const clientInfo = getClientInfo(request);
      
      if (['copy_clicks', 'telegram_clicks'].includes(type)) {
        await recordStat(KV, type, clientInfo.ip);
      }
      
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  } else if (request.method === 'GET') {
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
  const ignoredIP = await KV.get('ignored_ip');
  const cronReportEnabled = await KV.get('cron_report_enabled');
  
  return {
    SUBSCRIPTION_URL: subscriptionUrl || 'https://xx',
    TELEGRAM_GROUP: telegramGroup || 'https://t.me',
    TELEGRAM_BOT_TOKEN: telegramBotToken || '',
    TELEGRAM_CHAT_ID: telegramChatId || '',
    IGNORED_IP: ignoredIP || '',
    CRON_REPORT_ENABLED: cronReportEnabled !== 'false'
  };
}

// 获取北京日期字符串
function getBeijingDateString(date = new Date()) {
  const beijingOffset = 8 * 60;
  const localOffset = date.getTimezoneOffset();
  const beijingTime = new Date(date.getTime() + (beijingOffset + localOffset) * 60000);
  
  return beijingTime.toISOString().split('T')[0];
}

// 转换为北京时间
function convertToBeijingTime(date) {
  const beijingOffset = 8 * 60;
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
  const adminPassword = await KV.get('admin_password');
  
  if (!adminPassword) {
    return new Response(getSetupHTML(), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }
  
  const cookieHeader = request.headers.get('Cookie');
  const isLoggedIn = cookieHeader && cookieHeader.includes('admin_authenticated=true');
  
  if (!isLoggedIn) {
    return new Response(getLoginHTML(), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }
  
  const config = await getConfigFromKV(KV);
  const lastUpdated = await KV.get('last_updated') || '从未更新';
  const lastAutoCheck = await KV.get('last_auto_check') || '从未检查';
  const autoCheckStatus = await KV.get('auto_check_status') || 'unknown';
  const stats = await getStats(KV);
  
  return new Response(getAdminPanelHTML(config, lastUpdated, lastAutoCheck, autoCheckStatus, stats), {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
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
    const ignoredIP = formData.get('ignored_ip');
    const cronReportEnabled = formData.get('cron_report_enabled') === 'on';
    
    await KV.put('subscription_url', subscriptionUrl);
    await KV.put('telegram_group', telegramGroup);
    await KV.put('telegram_bot_token', telegramBotToken);
    await KV.put('telegram_chat_id', telegramChatId);
    await KV.put('ignored_ip', ignoredIP);
    await KV.put('cron_report_enabled', cronReportEnabled ? 'true' : 'false');
    
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

// ==================== 界面模板 ====================

// 初始设置页面
function getSetupHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>初始设置 - Link Manager</title>
    <style>
        :root {
            --primary-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            --success-color: #10b981;
            --error-color: #ef4444;
            --text-primary: #1f2937;
            --text-secondary: #6b7280;
            --bg-white: #ffffff;
            --border-color: #e5e7eb;
            --shadow-lg: 0 20px 60px rgba(0,0,0,0.3);
            --shadow-md: 0 10px 25px rgba(0,0,0,0.1);
        }
        
        * { 
            margin: 0; 
            padding: 0; 
            box-sizing: border-box; 
        }
        
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--primary-gradient);
            min-height: 100vh; 
            display: flex; 
            justify-content: center; 
            align-items: center;
            padding: 20px;
        }
        
        .card {
            background: var(--bg-white); 
            border-radius: 20px; 
            padding: 3rem;
            width: 100%; 
            max-width: 420px; 
            box-shadow: var(--shadow-lg);
            backdrop-filter: blur(10px);
        }
        
        .logo {
            text-align: center;
            margin-bottom: 2rem;
        }
        
        .logo-icon {
            width: 64px;
            height: 64px;
            background: var(--primary-gradient);
            border-radius: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 1rem;
            box-shadow: var(--shadow-md);
        }
        
        .logo-icon svg {
            width: 32px;
            height: 32px;
            fill: white;
        }
        
        h1 { 
            text-align: center; 
            margin-bottom: 1.5rem; 
            color: var(--text-primary);
            font-size: 1.875rem;
            font-weight: 700;
        }
        
        .subtitle {
            text-align: center;
            color: var(--text-secondary);
            margin-bottom: 2rem;
            line-height: 1.6;
        }
        
        .form-group { 
            margin-bottom: 1.5rem; 
        }
        
        label { 
            display: block; 
            margin-bottom: 0.5rem; 
            color: var(--text-primary); 
            font-weight: 500; 
        }
        
        input { 
            width: 100%; 
            padding: 0.875rem; 
            border: 2px solid var(--border-color); 
            border-radius: 12px; 
            font-size: 1rem; 
            transition: all 0.3s ease;
        }
        
        input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        
        button { 
            width: 100%; 
            padding: 1rem; 
            background: var(--primary-gradient);
            color: white; 
            border: none; 
            border-radius: 12px; 
            font-size: 1rem; 
            font-weight: 600;
            cursor: pointer; 
            transition: all 0.3s ease;
        }
        
        button:hover { 
            transform: translateY(-2px);
            box-shadow: var(--shadow-md);
        }
        
        .message { 
            padding: 1rem; 
            border-radius: 12px; 
            margin-bottom: 1.5rem; 
            text-align: center; 
            display: none; 
        }
        
        .success { 
            background: #ecfdf5; 
            color: var(--success-color); 
            border: 1px solid #d1fae5; 
        }
        
        .error { 
            background: #fef2f2; 
            color: var(--error-color); 
            border: 1px solid #fecaca; 
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="logo">
            <div class="logo-icon">
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z"/>
                </svg>
            </div>
            <h1>Link Manager</h1>
            <p class="subtitle">设置您的管理密码以开始使用</p>
        </div>
        
        <div id="message" class="message"></div>
        
        <form id="setupForm">
            <div class="form-group">
                <label for="password">管理密码</label>
                <input type="password" id="password" name="password" required 
                       placeholder="请输入安全的密码">
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

// 登录页面
function getLoginHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录 - Link Manager</title>
    <style>
        :root {
            --primary-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            --error-color: #ef4444;
            --text-primary: #1f2937;
            --text-secondary: #6b7280;
            --bg-white: #ffffff;
            --border-color: #e5e7eb;
            --shadow-lg: 0 20px 60px rgba(0,0,0,0.3);
            --shadow-md: 0 10px 25px rgba(0,0,0,0.1);
        }
        
        * { 
            margin: 0; 
            padding: 0; 
            box-sizing: border-box; 
        }
        
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--primary-gradient);
            min-height: 100vh; 
            display: flex; 
            justify-content: center; 
            align-items: center;
            padding: 20px;
        }
        
        .card {
            background: var(--bg-white); 
            border-radius: 20px; 
            padding: 3rem;
            width: 100%; 
            max-width: 420px; 
            box-shadow: var(--shadow-lg);
        }
        
        .logo {
            text-align: center;
            margin-bottom: 2rem;
        }
        
        .logo-icon {
            width: 64px;
            height: 64px;
            background: var(--primary-gradient);
            border-radius: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 1rem;
            box-shadow: var(--shadow-md);
        }
        
        .logo-icon svg {
            width: 32px;
            height: 32px;
            fill: white;
        }
        
        h1 { 
            text-align: center; 
            margin-bottom: 1.5rem; 
            color: var(--text-primary);
            font-size: 1.875rem;
            font-weight: 700;
        }
        
        .form-group { 
            margin-bottom: 1.5rem; 
        }
        
        label { 
            display: block; 
            margin-bottom: 0.5rem; 
            color: var(--text-primary); 
            font-weight: 500; 
        }
        
        input { 
            width: 100%; 
            padding: 0.875rem; 
            border: 2px solid var(--border-color); 
            border-radius: 12px; 
            font-size: 1rem; 
            transition: all 0.3s ease;
        }
        
        input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        
        button { 
            width: 100%; 
            padding: 1rem; 
            background: var(--primary-gradient);
            color: white; 
            border: none; 
            border-radius: 12px; 
            font-size: 1rem; 
            font-weight: 600;
            cursor: pointer; 
            transition: all 0.3s ease;
        }
        
        button:hover { 
            transform: translateY(-2px);
            box-shadow: var(--shadow-md);
        }
        
        .message { 
            padding: 1rem; 
            border-radius: 12px; 
            margin-bottom: 1.5rem; 
            text-align: center; 
            display: none; 
        }
        
        .error { 
            background: #fef2f2; 
            color: var(--error-color); 
            border: 1px solid #fecaca; 
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="logo">
            <div class="logo-icon">
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z"/>
                </svg>
            </div>
            <h1>管理员登录</h1>
        </div>
        
        <div id="message" class="message"></div>
        
        <form id="loginForm">
            <div class="form-group">
                <label for="password">管理密码</label>
                <input type="password" id="password" name="password" required 
                       placeholder="请输入管理密码">
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

// 管理面板HTML
function getAdminPanelHTML(config, lastUpdated, lastAutoCheck, autoCheckStatus, stats) {
  const statusConfig = {
    'active': { text: '正常', color: '#10b981' },
    'inactive': { text: '异常', color: '#ef4444' },
    'error': { text: '检查失败', color: '#f59e0b' },
    'unknown': { text: '未知', color: '#6b7280' }
  };
  
  const status = statusConfig[autoCheckStatus] || statusConfig.unknown;
  const telegramStatus = stats.telegram_configured ? 
    '<span style="color: #10b981;">✓ 已配置</span>' : 
    '<span style="color: #ef4444;">✗ 未配置</span>';
  
  const ignoredIPStatus = stats.ignored_ip && stats.ignored_ip !== '未设置' ? 
    `<span style="color: #10b981;">✓ 已设置: ${stats.ignored_ip}</span>` : 
    '<span style="color: #ef4444;">✗ 未设置</span>';

  const cronReportStatus = stats.cron_report_enabled ?
    '<span style="color: #10b981;">✓ 已启用</span>' :
    '<span style="color: #ef4444;">✗ 已禁用</span>';

  const ipLogsHTML = stats.ip_logs && stats.ip_logs.length > 0 
    ? stats.ip_logs.map(log => `
        <div class="log-entry">
          <div class="log-content">${log}</div>
        </div>
      `).join('')
    : '<div class="empty-state">暂无访问日志</div>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>管理面板 - Link Manager</title>
    <style>
        :root {
            --primary-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            --success-color: #10b981;
            --warning-color: #f59e0b;
            --error-color: #ef4444;
            --text-primary: #1f2937;
            --text-secondary: #6b7280;
            --bg-white: #ffffff;
            --bg-gray: #f8fafc;
            --border-color: #e5e7eb;
            --shadow-sm: 0 1px 3px rgba(0,0,0,0.1);
            --shadow-md: 0 4px 6px rgba(0,0,0,0.1);
            --shadow-lg: 0 10px 25px rgba(0,0,0,0.1);
        }
        
        * { 
            margin: 0; 
            padding: 0; 
            box-sizing: border-box; 
        }
        
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg-gray); 
            min-height: 100vh; 
            padding: 20px;
            color: var(--text-primary);
        }
        
        .container { 
            max-width: 1400px; 
            margin: 0 auto; 
        }
        
        .header { 
            background: var(--bg-white); 
            padding: 2rem; 
            border-radius: 20px; 
            box-shadow: var(--shadow-lg); 
            margin-bottom: 2rem;
            display: flex; 
            justify-content: space-between; 
            align-items: center;
        }
        
        .header-content h1 {
            font-size: 2rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
            background: var(--primary-gradient);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        
        .header-content p {
            color: var(--text-secondary);
        }
        
        .card {
            background: var(--bg-white); 
            padding: 2rem; 
            border-radius: 20px;
            box-shadow: var(--shadow-lg); 
            margin-bottom: 2rem;
        }
        
        h2 { 
            font-size: 1.5rem;
            font-weight: 600;
            margin-bottom: 1.5rem; 
            color: var(--text-primary);
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        
        h2::before {
            content: '';
            width: 4px;
            height: 20px;
            background: var(--primary-gradient);
            border-radius: 2px;
        }
        
        h3 { 
            color: var(--text-primary); 
            margin-bottom: 1rem; 
            font-size: 1.125rem;
        }
        
        .form-group { 
            margin-bottom: 1.5rem; 
        }
        
        label { 
            display: block; 
            margin-bottom: 0.5rem; 
            color: var(--text-primary); 
            font-weight: 500; 
        }
        
        input { 
            width: 100%; 
            padding: 0.875rem; 
            border: 2px solid var(--border-color); 
            border-radius: 12px; 
            font-size: 1rem; 
            transition: all 0.3s ease;
        }
        
        input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        
        .checkbox-group {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }
        
        .checkbox-group input[type="checkbox"] {
            width: auto;
            transform: scale(1.2);
        }
        
        button { 
            padding: 0.875rem 1.5rem; 
            background: var(--primary-gradient);
            color: white; 
            border: none; 
            border-radius: 12px; 
            font-size: 0.875rem; 
            font-weight: 600;
            cursor: pointer; 
            transition: all 0.3s ease;
            margin-right: 0.5rem;
            margin-bottom: 0.5rem;
        }
        
        button:hover { 
            transform: translateY(-2px);
            box-shadow: var(--shadow-md);
        }
        
        .button-secondary {
            background: #6b7280;
        }
        
        .button-success {
            background: var(--success-color);
        }
        
        .button-warning {
            background: var(--warning-color);
        }
        
        .message { 
            padding: 1rem; 
            border-radius: 12px; 
            margin-bottom: 1.5rem; 
            display: none; 
        }
        
        .success { 
            background: #ecfdf5; 
            color: var(--success-color); 
            border: 1px solid #d1fae5; 
        }
        
        .error { 
            background: #fef2f2; 
            color: var(--error-color); 
            border: 1px solid #fecaca; 
        }
        
        .info-box { 
            background: #eff6ff; 
            padding: 1.5rem; 
            border-radius: 12px; 
            border-left: 4px solid #3b82f6; 
            margin-bottom: 1.5rem;
            line-height: 1.6;
        }
        
        .stats-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
            gap: 1rem; 
            margin-bottom: 1.5rem;
        }
        
        .stat-card {
            background: var(--bg-white); 
            padding: 1.5rem; 
            border-radius: 12px;
            border-left: 4px solid #667eea; 
            box-shadow: var(--shadow-sm);
            text-align: center;
            transition: transform 0.3s ease;
        }
        
        .stat-card:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow-md);
        }
        
        .stat-number { 
            font-size: 2rem; 
            font-weight: 700; 
            color: var(--text-primary); 
            margin-bottom: 0.5rem;
        }
        
        .stat-label { 
            color: var(--text-secondary); 
            font-size: 0.875rem;
            font-weight: 500;
        }
        
        .status-badge {
            display: inline-block; 
            padding: 0.5rem 1rem; 
            border-radius: 20px;
            color: white; 
            font-size: 0.75rem; 
            font-weight: 600;
        }
        
        .logs-container {
            max-height: 500px; 
            overflow-y: auto; 
            border: 1px solid var(--border-color);
            border-radius: 12px; 
            padding: 1rem; 
            background: var(--bg-gray);
        }
        
        .log-entry {
            padding: 1rem;
            border-bottom: 1px solid var(--border-color);
            transition: background-color 0.2s ease;
        }
        
        .log-entry:hover {
            background-color: var(--bg-white);
        }
        
        .log-entry:last-child {
            border-bottom: none;
        }
        
        .log-content {
            font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
            font-size: 0.75rem;
            line-height: 1.5;
            white-space: pre-line;
            color: var(--text-primary);
        }
        
        .empty-state {
            text-align: center;
            padding: 3rem;
            color: var(--text-secondary);
        }
        
        .two-column {
            display: grid; 
            grid-template-columns: 1fr 1fr; 
            gap: 2rem;
        }
        
        .help-text {
            color: var(--text-secondary); 
            font-size: 0.75rem; 
            margin-top: 0.25rem;
            line-height: 1.4;
        }
        
        .section-divider {
            height: 1px;
            background: var(--border-color);
            margin: 2rem 0;
        }
        
        @media (max-width: 1024px) {
            .two-column { 
                grid-template-columns: 1fr; 
            }
        }
        
        @media (max-width: 768px) {
            .header {
                flex-direction: column;
                gap: 1rem;
                text-align: center;
            }
            
            .stats-grid {
                grid-template-columns: repeat(2, 1fr);
            }
        }
        
        @media (max-width: 480px) {
            .stats-grid {
                grid-template-columns: 1fr;
            }
            
            .card {
                padding: 1.5rem;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-content">
                <h1>Link Manager</h1>
                <p>配置您的订阅服务和管理统计信息</p>
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
                        <strong>忽略IP设置:</strong> ${ignoredIPStatus}<br>
                        <strong>定时任务报告:</strong> ${cronReportStatus}<br>
                        <strong>统计规则:</strong> 同一IP的多次复制或TG点击在一天内只计算一次
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
                        <span class="status-badge" style="background: ${status.color}">${status.text}</span><br>
                        <strong>Telegram通知:</strong> ${telegramStatus}<br>
                        <strong>定时任务报告:</strong> ${cronReportStatus}
                    </div>
                    
                    <form id="configForm">
                        <h3>基本配置</h3>
                        <div class="form-group">
                            <label for="subscription_url">订阅链接</label>
                            <input type="url" id="subscription_url" name="subscription_url" 
                                   value="${config.SUBSCRIPTION_URL}" required 
                                   placeholder="https://snippets.vlato.site">
                        </div>
                        
                        <div class="form-group">
                            <label for="telegram_group">Telegram群组链接</label>
                            <input type="url" id="telegram_group" name="telegram_group" 
                                   value="${config.TELEGRAM_GROUP}" required 
                                   placeholder="https://t.me/your_group">
                        </div>
                        
                        <div class="section-divider"></div>
                        
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
                        
                        <div class="section-divider"></div>
                        
                        <h3>高级配置</h3>
                        <div class="form-group">
                            <label for="ignored_ip">忽略的IP地址</label>
                            <input type="text" id="ignored_ip" name="ignored_ip" 
                                   value="${config.IGNORED_IP}" 
                                   placeholder="例如: 192.168.1.1 或 2a06:98c0:3600::103">
                            <div class="help-text">
                                设置此IP后，该IP的访问将不会被记录在统计和IP日志中（支持IPv4和IPv6）
                            </div>
                        </div>
                        
                        <div class="form-group">
                            <div class="checkbox-group">
                                <input type="checkbox" id="cron_report_enabled" name="cron_report_enabled" ${config.CRON_REPORT_ENABLED ? 'checked' : ''}>
                                <label for="cron_report_enabled">启用定时任务报告</label>
                            </div>
                            <div class="help-text">
                                启用后，定时任务执行时会发送统计报告到Telegram（不影响链接检查失败或恢复的通知）
                            </div>
                        </div>
                        
                        <div style="display: flex; gap: 1rem; flex-wrap: wrap;">
                            <button type="submit">更新配置</button>
                            <button type="button" onclick="testTelegram()" class="button-success">测试通知</button>
                            <button type="button" onclick="window.location.href='/'" class="button-secondary">返回主页</button>
                        </div>
                    </form>
                </div>
            </div>
            
            <!-- 右侧：访问日志 -->
            <div>
                <div class="card">
                    <h2>访问IP日志</h2>
                    <div class="info-box">
                        <strong>地理位置信息:</strong> 记录访问者的国家、城市和网络信息<br>
                        <strong>忽略IP:</strong> ${stats.ignored_ip} 的访问不会被记录<br>
                        <strong>IPv6支持:</strong> 已完全支持IPv6地址识别和忽略
                    </div>
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

// 主页面HTML - 优化移动端间距版本
function getHTML(subscriptionUrl, telegramGroup) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hello Snippets!</title>
    <style>
        :root {
            --primary-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            --success-color: #10b981;
            --warning-color: #f59e0b;
            --error-color: #ef4444;
            --text-primary: #1f2937;
            --text-secondary: #6b7280;
            --bg-white: #ffffff;
            --shadow-lg: 0 20px 60px rgba(0, 0, 0, 0.3);
            --shadow-md: 0 10px 25px rgba(0, 0, 0, 0.1);
            --shadow-sm: 0 4px 12px rgba(0, 0, 0, 0.1);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--primary-gradient);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
            line-height: 1.6;
        }

        .card {
            background: var(--bg-white);
            border-radius: 24px;
            padding: 2.5rem 2rem;
            width: 100%;
            max-width: 440px;
            box-shadow: var(--shadow-lg);
            text-align: center;
            position: relative;
            overflow: hidden;
        }

        .card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 5px;
            background: var(--primary-gradient);
        }

        .icon {
            width: 72px;
            height: 72px;
            background: var(--primary-gradient);
            border-radius: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0 auto 2rem;
            box-shadow: var(--shadow-md);
            transition: transform 0.3s ease;
        }

        .icon:hover {
            transform: scale(1.05) rotate(5deg);
        }

        .icon svg {
            width: 36px;
            height: 36px;
            fill: white;
        }

        h1 {
            font-size: 2.25rem;
            font-weight: 800;
            background: var(--primary-gradient);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 1rem;
            letter-spacing: -0.5px;
            line-height: 1.2;
        }

        .status {
            color: white;
            padding: 0.75rem 1.25rem;
            border-radius: 50px;
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.9rem;
            font-weight: 600;
            margin-bottom: 1.25rem;
            transition: all 0.3s ease;
            box-shadow: var(--shadow-sm);
            min-height: 44px;
        }

        .status.active {
            background: var(--success-color);
        }

        .status.inactive {
            background: var(--error-color);
        }

        .status.checking {
            background: var(--warning-color);
        }

        .status::before {
            font-size: 1rem;
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
            color: var(--text-secondary);
            font-size: 0.85rem;
            margin-bottom: 2rem;
            background: #f8fafc;
            padding: 0.75rem 1rem;
            border-radius: 12px;
            display: inline-block;
            border: 1px solid #e2e8f0;
            line-height: 1.4;
        }

        @keyframes rotate {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }

        .description {
            color: var(--text-secondary);
            font-size: 1rem;
            margin-bottom: 2rem;
            line-height: 1.6;
            padding: 0 0.5rem;
        }

        .button {
            width: 100%;
            padding: 1.125rem 1.5rem;
            border: none;
            border-radius: 16px;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.75rem;
            margin-bottom: 1rem;
            text-decoration: none;
            color: white;
            position: relative;
            overflow: hidden;
            box-shadow: var(--shadow-sm);
            min-height: 56px;
        }

        .button::before {
            font-size: 1.125rem;
        }

        .button-purple {
            background: var(--primary-gradient);
        }

        .button-purple:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow-md);
        }

        .button-cyan {
            background: linear-gradient(135deg, #0891b2 0%, #06b6d4 100%);
        }

        .button-cyan:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(8, 145, 178, 0.3);
        }

        .button-copied {
            background: linear-gradient(135deg, var(--success-color) 0%, #059669 100%) !important;
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

        .copy-feedback {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(16, 185, 129, 0.95);
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.3s ease;
            border-radius: 16px;
            font-weight: 600;
        }

        .copy-feedback.show {
            opacity: 1;
        }
        
        .admin-link {
            display: inline-block;
            margin: 1.5rem 0 0.5rem;
            color: #667eea;
            text-decoration: none;
            font-size: 0.9rem;
            font-weight: 500;
            transition: color 0.3s ease;
            padding: 0.5rem 1rem;
            border-radius: 8px;
            background: #f8fafc;
        }

        .admin-link::before {
            content: "⚙️";
            margin-right: 6px;
        }
                
        .admin-link:hover {
            color: #5a67d8;
            background: #f1f5f9;
            text-decoration: none;
        }

        .footer {
            margin-top: 2rem;
            color: var(--text-secondary);
            font-size: 0.8rem;
            padding-top: 1rem;
            border-top: 1px solid #f1f5f9;
        }

        .pulse {
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.05); }
            100% { transform: scale(1); }
        }

        /* 平板端优化 */
        @media (max-width: 768px) {
            body {
                padding: 16px;
            }
            
            .card {
                padding: 2rem 1.5rem;
                border-radius: 20px;
            }
            
            .icon {
                width: 64px;
                height: 64px;
                margin-bottom: 1.75rem;
            }
            
            .icon svg {
                width: 32px;
                height: 32px;
            }
            
            h1 {
                font-size: 2rem;
                margin-bottom: 0.875rem;
            }
            
            .status {
                padding: 0.625rem 1.125rem;
                font-size: 0.85rem;
                margin-bottom: 1.125rem;
                min-height: 40px;
            }
            
            .description {
                font-size: 0.95rem;
                margin-bottom: 1.75rem;
            }
            
            .button {
                padding: 1rem 1.25rem;
                font-size: 0.95rem;
                margin-bottom: 0.875rem;
                min-height: 52px;
            }
        }

        /* 移动端优化 */
        @media (max-width: 480px) {
            body {
                padding: 12px;
                align-items: flex-start;
                min-height: 100vh;
                padding-top: 20px;
            }
            
            .card {
                padding: 1.75rem 1.25rem;
                border-radius: 20px;
                margin: 0;
            }
            
            .icon {
                width: 60px;
                height: 60px;
                margin-bottom: 1.5rem;
                border-radius: 16px;
            }
            
            .icon svg {
                width: 28px;
                height: 28px;
            }
            
            h1 {
                font-size: 1.75rem;
                margin-bottom: 0.75rem;
            }
            
            .status {
                padding: 0.75rem 1rem;
                font-size: 0.8rem;
                margin-bottom: 1rem;
                min-height: 44px;
                width: 100%;
                justify-content: center;
            }
            
            .update-time {
                font-size: 0.8rem;
                margin-bottom: 1.5rem;
                padding: 0.625rem 0.875rem;
                width: 100%;
            }
            
            .description {
                font-size: 0.9rem;
                margin-bottom: 1.5rem;
                line-height: 1.5;
                padding: 0;
            }
            
            .button {
                padding: 1rem;
                font-size: 0.9rem;
                margin-bottom: 0.75rem;
                min-height: 50px;
                border-radius: 14px;
            }
            
            .button::before {
                font-size: 16px;
            }
            
            .admin-link {
                margin: 1.25rem 0 0.5rem;
                font-size: 0.85rem;
                padding: 0.5rem 0.875rem;
            }
            
            .footer {
                margin-top: 1.5rem;
                font-size: 0.75rem;
            }
        }

        /* 小屏手机优化 */
        @media (max-width: 360px) {
            .card {
                padding: 1.5rem 1rem;
                border-radius: 18px;
            }
            
            h1 {
                font-size: 1.5rem;
            }
            
            .icon {
                width: 56px;
                height: 56px;
                margin-bottom: 1.25rem;
            }
            
            .status {
                padding: 0.625rem 0.875rem;
                font-size: 0.75rem;
            }
            
            .button {
                padding: 0.875rem;
                font-size: 0.85rem;
            }
        }

        /* 超大屏幕优化 */
        @media (min-width: 1200px) {
            .card {
                max-width: 480px;
                padding: 3rem 2.5rem;
            }
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon pulse">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z"/>
            </svg>
        </div>
        
        <h1>Hello Snippets!</h1>
        
        <div id="statusBadge" class="status checking">正在检测服务状态...</div>
        
        <p class="description">
            您的代理服务正在正常运行，享受安全、快速的网络连接体验
        </p>
        
        <div id="updateTime" class="update-time">检测更新时间...</div>
        
        <button id="copyButton" class="button button-purple">
            <span>订阅链接（点击复制）</span>
            <div id="copyFeedback" class="copy-feedback">
                <span>✅ 已复制到剪贴板！</span>
            </div>
        </button>
        
        <a href="${telegramGroup}" target="_blank" id="tgButton" class="button button-cyan">
            <span>加入 Telegram 交流群组</span>
        </a>
        
        <a href="/admin" class="admin-link">管理面板</a>
        
        <div class="footer">
            Powered by Cloudflare Workers
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
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: type })
                });
            } catch (error) {
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
                    statusBadge.textContent = '🎉 代理功能已启用';
                    
                    if (data.lastModified) {
                        updateTime.textContent = '最后更新: ' + data.lastModified;
                    } else {
                        updateTime.textContent = '最后更新: 未知';
                    }
                } else {
                    statusBadge.className = 'status inactive';
                    statusBadge.textContent = '❌ 代理功能已失效';
                    updateTime.textContent = '更新检测失败';
                }
            } catch (error) {
                statusBadge.className = 'status inactive';
                statusBadge.textContent = '❌ 代理功能检测失败';
                updateTime.textContent = '网络连接异常';
            }
        }

        function copyToClipboard() {
            navigator.clipboard.writeText(subscriptionUrl).then(function() {
                copyButton.classList.add('button-copied');
                copyFeedback.classList.add('show');
                
                recordStat('copy_clicks');
                
                setTimeout(function() {
                    copyButton.classList.remove('button-copied');
                    copyFeedback.classList.remove('show');
                }, 2000);
            }).catch(function(err) {
                console.error('复制失败:', err);
                copyButton.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
                copyButton.querySelector('span').textContent = '复制失败';
                
                setTimeout(function() {
                    copyButton.style.background = '';
                    copyButton.querySelector('span').textContent = '订阅链接（点击复制）';
                }, 2000);
            });
        }

        copyButton.addEventListener('click', copyToClipboard);
        tgButton.addEventListener('click', function() {
            recordStat('telegram_clicks');
        });

        // 页面加载时检查状态
        window.addEventListener('DOMContentLoaded', checkLinkStatus);
        
        // 每30秒自动检查状态
        setInterval(checkLinkStatus, 30000);
    </script>
</body>
</html>`;
}