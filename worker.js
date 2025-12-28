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
      '/admin/api/add-link': () => handleAddLink(request, KV),
      '/admin/api/delete-link': () => handleDeleteLink(request, KV),
      '/admin/api/update-link': () => handleUpdateLink(request, KV),
      '/admin/api/reorder-links': () => handleReorderLinks(request, KV),
      '/api/stats': () => handleStats(request, KV),
      '/admin/api/test-telegram': () => handleTestTelegram(request, KV),
      '/api/check-links': async () => {
        const CONFIG = await getConfigFromKV(KV);
        return handleCheckLinks(CONFIG, KV);
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
    return new Response(getHTML(CONFIG.LINKS, CONFIG.TELEGRAM_GROUP, CONFIG.TELEGRAM_BUTTON_TEXT, CONFIG.TELEGRAM_BUTTON_HIDDEN), {
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
    const links = config.LINKS || [];
    
    if (links.length === 0) {
      return '❌ 没有配置订阅链接，跳过自动检查';
    }
    
    let results = [];
    let hasStatusChange = false;
    
    for (const link of links) {
      if (!link.url || link.url === 'https://xx') {
        results.push(`❌ "${link.name}"：未配置链接`);
        continue;
      }
      
      try {
        const response = await fetch(link.url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000)
        });
        
        const isActive = response.ok || (response.status >= 200 && response.status < 400);
        const previousStatus = link.status || 'unknown';
        
        // 更新链接状态
        link.status = isActive ? 'active' : 'inactive';
        link.lastChecked = convertToBeijingTime(new Date());
        
        results.push(`✅ "${link.name}"：${isActive ? '正常' : '异常'}`);
        
        // 状态变化通知
        if (previousStatus === 'active' && !isActive) {
          const message = `🔴 <b>订阅链接异常</b>\n\n` +
                         `链接名称: ${link.name}\n` +
                         `链接地址: ${link.url}\n` +
                         `状态: 连接失败\n` +
                         `时间: ${convertToBeijingTime(new Date())}\n` +
                         `请及时检查服务状态。`;
          
          await sendTelegramMessage(KV, message);
          results[results.length - 1] += ' 🔴 (已发送异常通知)';
          hasStatusChange = true;
        }
        
        if (previousStatus === 'inactive' && isActive) {
          const message = `🟢 <b>订阅链接已恢复</b>\n\n` +
                         `链接名称: ${link.name}\n` +
                         `链接地址: ${link.url}\n` +
                         `状态: 连接正常\n` +
                         `时间: ${convertToBeijingTime(new Date())}\n` +
                         `服务已恢复正常。`;
          
          await sendTelegramMessage(KV, message);
          results[results.length - 1] += ' 🟢 (已发送恢复通知)';
          hasStatusChange = true;
        }
        
      } catch (error) {
        const previousStatus = link.status || 'unknown';
        link.status = 'error';
        link.lastChecked = convertToBeijingTime(new Date());
        
        results.push(`❌ "${link.name}"：检查失败 (${error.message})`);
        
        if (previousStatus === 'active') {
          const message = `🔴 <b>订阅链接检查失败</b>\n\n` +
                         `链接名称: ${link.name}\n` +
                         `链接地址: ${link.url}\n` +
                         `错误: ${error.message}\n` +
                         `时间: ${convertToBeijingTime(new Date())}\n` +
                         `请检查网络连接或服务状态。`;
          
          await sendTelegramMessage(KV, message);
          results[results.length - 1] += ' 🔴 (已发送失败通知)';
          hasStatusChange = true;
        }
      }
    }
    
    // 保存更新后的链接状态
    await KV.put('subscription_links', JSON.stringify(links));
    await KV.put('last_auto_check', convertToBeijingTime(new Date()));
    
    return `链接检查完成:\n${results.join('\n')}`;
    
  } catch (error) {
    return `❌ 链接检查过程出错: ${error.message}`;
  }
}

// 处理链接检查API
async function handleCheckLinks(CONFIG, KV) {
  try {
    const links = CONFIG.LINKS || [];
    const checkResults = [];
    
    for (const link of links) {
      if (!link.url || link.url === 'https://xx') {
        checkResults.push({
          id: link.id,
          name: link.name,
          active: false,
          error: '链接未配置',
          lastModified: link.lastUpdated || '从未更新'
        });
        continue;
      }
      
      try {
        const response = await fetch(link.url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000)
        });
        
        const isActive = response.ok || (response.status >= 200 && response.status < 400);
        
        checkResults.push({
          id: link.id,
          name: link.name,
          active: isActive,
          status: response.status,
          lastModified: link.lastUpdated || '从未更新'
        });
      } catch (error) {
        checkResults.push({
          id: link.id,
          name: link.name,
          active: false,
          error: error.message,
          lastModified: link.lastUpdated || '从未更新'
        });
      }
    }
    
    return new Response(JSON.stringify({ links: checkResults }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: error.message,
      links: []
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
async function recordStat(KV, statType, clientIP, linkId = null) {
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
  
  // 检查IP是否已经记录过该事件（如果指定了linkId，则按linkId去重）
  const ipSetKey = linkId ? 
    `daily_${statType}_ips_${today}_${linkId}` : 
    `daily_${statType}_ips_${today}`;
    
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
  const telegramButtonText = await KV.get('telegram_button_text') || '加入 Telegram 交流群组';
  const telegramButtonHidden = await KV.get('telegram_button_hidden');
  
  return {
    page_views: parseInt(await KV.get('daily_page_views') || '0'),
    copy_clicks: parseInt(await KV.get('daily_copy_clicks') || '0'),
    telegram_clicks: parseInt(await KV.get('daily_telegram_clicks') || '0'),
    unique_visitors: uniqueVisitors,
    ip_logs: ipLogs,
    telegram_configured: !!(botToken && chatId),
    ignored_ip: ignoredIP,
    cron_report_enabled: cronReportEnabled !== 'false',
    telegram_button_text: telegramButtonText,
    telegram_button_hidden: telegramButtonHidden === 'true',
    reset_date: lastResetDate || today
  };
}

// 处理统计API
async function handleStats(request, KV) {
  if (request.method === 'POST') {
    try {
      const data = await request.json();
      const { type, linkId } = data;
      const clientInfo = getClientInfo(request);
      
      if (['copy_clicks', 'telegram_clicks'].includes(type)) {
        await recordStat(KV, type, clientInfo.ip, linkId);
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
  const telegramGroup = await KV.get('telegram_group');
  const telegramBotToken = await KV.get('telegram_bot_token');
  const telegramChatId = await KV.get('telegram_chat_id');
  const ignoredIP = await KV.get('ignored_ip');
  const cronReportEnabled = await KV.get('cron_report_enabled');
  const telegramButtonText = await KV.get('telegram_button_text');
  const telegramButtonHidden = await KV.get('telegram_button_hidden');
  
  // 获取链接列表
  let links = [];
  try {
    const linksData = await KV.get('subscription_links');
    if (linksData) {
      links = JSON.parse(linksData);
    } else {
      // 兼容旧版本：从单个链接迁移
      const oldUrl = await KV.get('subscription_url');
      if (oldUrl && oldUrl !== 'https://xx') {
        links = [{
          id: '1',
          name: '默认订阅',
          url: oldUrl,
          description: '从旧版本迁移',
          order: 0,
          status: 'unknown',
          lastUpdated: await KV.get('last_updated') || convertToBeijingTime(new Date())
        }];
        await KV.put('subscription_links', JSON.stringify(links));
      }
    }
  } catch (error) {
    console.error('获取链接配置失败:', error);
  }
  
  return {
    LINKS: links,
    TELEGRAM_GROUP: telegramGroup || 'https://t.me',
    TELEGRAM_BOT_TOKEN: telegramBotToken || '',
    TELEGRAM_CHAT_ID: telegramChatId || '',
    IGNORED_IP: ignoredIP || '',
    CRON_REPORT_ENABLED: cronReportEnabled !== 'false',
    TELEGRAM_BUTTON_TEXT: telegramButtonText || '加入 Telegram 交流群组',
    TELEGRAM_BUTTON_HIDDEN: telegramButtonHidden === 'true'
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
    const telegramGroup = formData.get('telegram_group');
    const telegramBotToken = formData.get('telegram_bot_token');
    const telegramChatId = formData.get('telegram_chat_id');
    const ignoredIP = formData.get('ignored_ip');
    const cronReportEnabled = formData.get('cron_report_enabled') === 'on';
    const telegramButtonText = formData.get('telegram_button_text');
    const telegramButtonHidden = formData.get('telegram_button_hidden') === 'on';
    
    await KV.put('telegram_group', telegramGroup);
    await KV.put('telegram_bot_token', telegramBotToken);
    await KV.put('telegram_chat_id', telegramChatId);
    await KV.put('ignored_ip', ignoredIP);
    await KV.put('cron_report_enabled', cronReportEnabled ? 'true' : 'false');
    await KV.put('telegram_button_text', telegramButtonText);
    await KV.put('telegram_button_hidden', telegramButtonHidden ? 'true' : 'false');
    
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

// 添加新链接
async function handleAddLink(request, KV) {
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
    const name = formData.get('name');
    const url = formData.get('url');
    const description = formData.get('description') || '';
    
    if (!name || !url) {
      return new Response(JSON.stringify({ success: false, error: '名称和URL不能为空' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const config = await getConfigFromKV(KV);
    const links = config.LINKS || [];
    
    // 生成唯一ID
    const newId = Date.now().toString();
    const newLink = {
      id: newId,
      name,
      url,
      description,
      order: links.length,
      status: 'unknown',
      lastUpdated: convertToBeijingTime(new Date())
    };
    
    links.push(newLink);
    await KV.put('subscription_links', JSON.stringify(links));
    
    return new Response(JSON.stringify({ 
      success: true, 
      message: '链接添加成功',
      link: newLink
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 删除链接
async function handleDeleteLink(request, KV) {
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
    const { linkId } = await request.json();
    
    if (!linkId) {
      return new Response(JSON.stringify({ success: false, error: '链接ID不能为空' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const config = await getConfigFromKV(KV);
    const links = config.LINKS || [];
    
    const filteredLinks = links.filter(link => link.id !== linkId);
    
    if (filteredLinks.length === links.length) {
      return new Response(JSON.stringify({ success: false, error: '链接不存在' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 重新排序
    filteredLinks.forEach((link, index) => {
      link.order = index;
    });
    
    await KV.put('subscription_links', JSON.stringify(filteredLinks));
    
    return new Response(JSON.stringify({ 
      success: true, 
      message: '链接删除成功'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 更新链接
async function handleUpdateLink(request, KV) {
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
    const linkId = formData.get('linkId');
    const name = formData.get('name');
    const url = formData.get('url');
    const description = formData.get('description') || '';
    
    if (!linkId || !name || !url) {
      return new Response(JSON.stringify({ success: false, error: '参数不能为空' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const config = await getConfigFromKV(KV);
    const links = config.LINKS || [];
    
    const linkIndex = links.findIndex(link => link.id === linkId);
    if (linkIndex === -1) {
      return new Response(JSON.stringify({ success: false, error: '链接不存在' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    links[linkIndex] = {
      ...links[linkIndex],
      name,
      url,
      description,
      lastUpdated: convertToBeijingTime(new Date())
    };
    
    await KV.put('subscription_links', JSON.stringify(links));
    
    return new Response(JSON.stringify({ 
      success: true, 
      message: '链接更新成功',
      link: links[linkIndex]
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 重新排序链接
async function handleReorderLinks(request, KV) {
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
    const { orderedIds } = await request.json();
    
    if (!orderedIds || !Array.isArray(orderedIds)) {
      return new Response(JSON.stringify({ success: false, error: '参数无效' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const config = await getConfigFromKV(KV);
    const links = config.LINKS || [];
    
    // 创建ID到链接的映射
    const linkMap = {};
    links.forEach(link => {
      linkMap[link.id] = link;
    });
    
    // 按照新的顺序重新排列
    const reorderedLinks = [];
    orderedIds.forEach((id, index) => {
      if (linkMap[id]) {
        linkMap[id].order = index;
        reorderedLinks.push(linkMap[id]);
      }
    });
    
    // 添加可能遗漏的链接（如果有的话）
    links.forEach(link => {
      if (!orderedIds.includes(link.id)) {
        link.order = reorderedLinks.length;
        reorderedLinks.push(link);
      }
    });
    
    await KV.put('subscription_links', JSON.stringify(reorderedLinks));
    
    return new Response(JSON.stringify({ 
      success: true, 
      message: '链接顺序已更新'
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

// 初始设置页面（保持不变）
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

// 登录页面（保持不变）
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

// 管理面板HTML（已修改增加Telegram按钮自定义配置）
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
    '<span style="color: #10b981;">✓ 已设置: ' + stats.ignored_ip + '</span>' : 
    '<span style="color: #ef4444;">✗ 未设置</span>';

  const cronReportStatus = stats.cron_report_enabled ?
    '<span style="color: #10b981;">✓ 已启用</span>' :
    '<span style="color: #ef4444;">✗ 已禁用</span>';

  const telegramButtonStatus = stats.telegram_button_hidden ?
    '<span style="color: #ef4444;">✗ 已隐藏</span>' :
    '<span style="color: #10b981;">✓ 显示中</span>';

  // 生成IP日志HTML
  const ipLogsHTML = stats.ip_logs && stats.ip_logs.length > 0 
    ? stats.ip_logs.map(log => {
        return '<div class="log-entry">' +
                 '<div class="log-content">' + log + '</div>' +
               '</div>';
      }).join('')
    : '<div class="empty-state">暂无访问日志</div>';

  // 链接管理部分
  const links = config.LINKS || [];
  const linksHTML = links.length > 0 
    ? links.sort((a, b) => (a.order || 0) - (b.order || 0)).map(link => {
        const linkStatus = statusConfig[link.status] || statusConfig.unknown;
        return '<div class="link-item" data-id="' + link.id + '">' +
                 '<div class="link-drag-handle">⋮⋮</div>' +
                 '<div class="link-content">' +
                   '<div class="link-header">' +
                     '<h4>' + link.name + '</h4>' +
                     '<div class="link-status ' + (link.status || 'unknown') + '">' +
                       linkStatus.text +
                     '</div>' +
                   '</div>' +
                   '<div class="link-url">' + link.url + '</div>' +
                   (link.description ? '<div class="link-description">' + link.description + '</div>' : '') +
                   '<div class="link-meta">' +
                     '最后更新: ' + (link.lastUpdated || '从未更新') + ' | ' +
                     '最后检查: ' + (link.lastChecked || '从未检查') +
                   '</div>' +
                 '</div>' +
                 '<div class="link-actions">' +
                   '<button class="edit-link" onclick="editLink(\'' + link.id + '\')">编辑</button>' +
                   '<button class="delete-link" onclick="deleteLink(\'' + link.id + '\')">删除</button>' +
                 '</div>' +
               '</div>';
      }).join('')
    : '<div class="empty-state">暂无订阅链接，请添加您的第一个链接</div>';

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
        
        input, textarea { 
            width: 100%; 
            padding: 0.875rem; 
            border: 2px solid var(--border-color); 
            border-radius: 12px; 
            font-size: 1rem; 
            transition: all 0.3s ease;
        }
        
        textarea {
            min-height: 100px;
            resize: vertical;
        }
        
        input:focus, textarea:focus {
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
        
        .button-danger {
            background: var(--error-color);
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
        
        /* 链接管理样式 */
        .links-container {
            margin-bottom: 2rem;
        }
        
        .link-item {
            display: flex;
            align-items: center;
            padding: 1.5rem;
            background: var(--bg-gray);
            border-radius: 12px;
            margin-bottom: 1rem;
            border: 1px solid var(--border-color);
            transition: all 0.3s ease;
            cursor: move;
        }
        
        .link-item:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow-md);
            border-color: #667eea;
        }
        
        .link-item.dragging {
            opacity: 0.5;
            background: #e5e7eb;
        }
        
        .link-drag-handle {
            padding: 0.5rem 1rem;
            color: var(--text-secondary);
            cursor: move;
            font-size: 1.25rem;
            user-select: none;
        }
        
        .link-content {
            flex: 1;
            margin: 0 1rem;
        }
        
        .link-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 0.5rem;
        }
        
        .link-header h4 {
            margin: 0;
            font-size: 1.125rem;
            color: var(--text-primary);
        }
        
        .link-status {
            padding: 0.25rem 0.75rem;
            border-radius: 20px;
            font-size: 0.75rem;
            font-weight: 600;
        }
        
        .link-status.active {
            background: #d1fae5;
            color: #065f46;
        }
        
        .link-status.inactive {
            background: #fee2e2;
            color: #991b1b;
        }
        
        .link-status.error {
            background: #fef3c7;
            color: #92400e;
        }
        
        .link-status.unknown {
            background: #e5e7eb;
            color: #4b5563;
        }
        
        .link-url {
            font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
            font-size: 0.875rem;
            color: var(--text-secondary);
            margin-bottom: 0.5rem;
            word-break: break-all;
        }
        
        .link-description {
            font-size: 0.875rem;
            color: var(--text-secondary);
            margin-bottom: 0.5rem;
            line-height: 1.4;
        }
        
        .link-meta {
            font-size: 0.75rem;
            color: var(--text-secondary);
        }
        
        .link-actions {
            display: flex;
            gap: 0.5rem;
        }
        
        .link-actions button {
            padding: 0.5rem 1rem;
            font-size: 0.75rem;
        }
        
        .add-link-form {
            background: var(--bg-gray);
            padding: 1.5rem;
            border-radius: 12px;
            border: 2px dashed var(--border-color);
            margin-bottom: 2rem;
        }
        
        .add-link-form.hidden {
            display: none;
        }
        
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 1000;
            align-items: center;
            justify-content: center;
        }
        
        .modal-content {
            background: white;
            border-radius: 20px;
            padding: 2rem;
            width: 90%;
            max-width: 500px;
            max-height: 90vh;
            overflow-y: auto;
        }
        
        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.5rem;
        }
        
        .modal-header h3 {
            margin: 0;
        }
        
        .modal-close {
            background: none;
            border: none;
            font-size: 1.5rem;
            cursor: pointer;
            color: var(--text-secondary);
        }
        
        @media (max-width: 1024px) {
            .two-column { 
                grid-template-columns: 1fr; 
            }
            
            .link-item {
                flex-direction: column;
                align-items: stretch;
            }
            
            .link-drag-handle {
                align-self: flex-start;
                margin-bottom: 1rem;
            }
            
            .link-content {
                margin: 1rem 0;
            }
            
            .link-actions {
                align-self: flex-end;
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
            
            .card {
                padding: 1.5rem;
            }
        }
        
        @media (max-width: 480px) {
            .stats-grid {
                grid-template-columns: 1fr;
            }
            
            .card {
                padding: 1.25rem;
            }
            
            .link-header {
                flex-direction: column;
                align-items: flex-start;
                gap: 0.5rem;
            }
            
            .link-actions {
                width: 100%;
                justify-content: flex-end;
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
                        <strong>Telegram按钮:</strong> ${telegramButtonStatus}<br>
                        <strong>统计规则:</strong> 同一IP的多次复制或TG点击在一天内只计算一次
                    </div>
                </div>
                
                <!-- 订阅链接管理 -->
                <div class="card">
                    <h2>订阅链接管理</h2>
                    <div id="message" class="message"></div>
                    
                    <div class="info-box">
                        <strong>最后配置更新时间:</strong> ${lastUpdated}<br>
                        <strong>最后自动检查时间:</strong> ${lastAutoCheck}<br>
                        <strong>自动检查状态:</strong> 
                        <span class="status-badge" style="background: ${status.color}">${status.text}</span><br>
                        <strong>Telegram通知:</strong> ${telegramStatus}<br>
                        <strong>定时任务报告:</strong> ${cronReportStatus}<br>
                        <strong>链接数量:</strong> ${links.length} 个
                    </div>
                    
                    <div class="links-container" id="linksContainer">
                        ${linksHTML}
                    </div>
                    
                    <div class="add-link-form" id="addLinkForm">
                        <h3>添加新链接</h3>
                        <form id="newLinkForm">
                            <div class="form-group">
                                <label for="linkName">链接名称</label>
                                <input type="text" id="linkName" name="name" required 
                                       placeholder="例如：主订阅链接">
                            </div>
                            <div class="form-group">
                                <label for="linkUrl">订阅链接URL</label>
                                <input type="url" id="linkUrl" name="url" required 
                                       placeholder="https://snippets.vlato.site">
                            </div>
                            <div class="form-group">
                                <label for="linkDescription">描述（可选）</label>
                                <textarea id="linkDescription" name="description" 
                                          placeholder="添加一些描述信息，例如：备用节点、地区限制等"></textarea>
                            </div>
                            <div style="display: flex; gap: 1rem;">
                                <button type="submit" class="button-success">添加链接</button>
                                <button type="button" onclick="hideAddLinkForm()" class="button-secondary">取消</button>
                            </div>
                        </form>
                    </div>
                    
                    <div style="display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 1rem;">
                        <button onclick="showAddLinkForm()" class="button-success">+ 添加新链接</button>
                        <button onclick="testTelegram()" class="button-warning">测试通知</button>
                        <button onclick="window.location.href='/'">返回主页</button>
                    </div>
                </div>
                
                <!-- 其他配置 -->
                <div class="card">
                    <h2>系统配置</h2>
                    <form id="configForm">
                        <h3>基本配置</h3>
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
                        
                        <div class="section-divider"></div>
                        
                        <h3>主页按钮配置</h3>
                        <div class="form-group">
                            <label for="telegram_button_text">Telegram按钮文字</label>
                            <input type="text" id="telegram_button_text" name="telegram_button_text" 
                                   value="${config.TELEGRAM_BUTTON_TEXT}" 
                                   placeholder="例如：加入 Telegram 交流群组">
                            <div class="help-text">
                                自定义主页Telegram按钮显示的文字内容
                            </div>
                        </div>
                        
                        <div class="form-group">
                            <div class="checkbox-group">
                                <input type="checkbox" id="telegram_button_hidden" name="telegram_button_hidden" ${config.TELEGRAM_BUTTON_HIDDEN ? 'checked' : ''}>
                                <label for="telegram_button_hidden">隐藏Telegram按钮</label>
                            </div>
                            <div class="help-text">
                                勾选后，主页将不显示Telegram按钮
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
                        
                        <button type="submit">更新配置</button>
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
    
    <!-- 编辑链接模态框 -->
    <div class="modal" id="editLinkModal">
        <div class="modal-content">
            <div class="modal-header">
                <h3>编辑链接</h3>
                <button class="modal-close" onclick="closeEditModal()">×</button>
            </div>
            <form id="editLinkForm">
                <input type="hidden" id="editLinkId" name="linkId">
                <div class="form-group">
                    <label for="editLinkName">链接名称</label>
                    <input type="text" id="editLinkName" name="name" required>
                </div>
                <div class="form-group">
                    <label for="editLinkUrl">订阅链接URL</label>
                    <input type="url" id="editLinkUrl" name="url" required>
                </div>
                <div class="form-group">
                    <label for="editLinkDescription">描述（可选）</label>
                    <textarea id="editLinkDescription" name="description"></textarea>
                </div>
                <div style="display: flex; gap: 1rem;">
                    <button type="submit" class="button-success">保存更改</button>
                    <button type="button" onclick="closeEditModal()" class="button-secondary">取消</button>
                </div>
            </form>
        </div>
    </div>
    
    <script>
        // 拖拽排序功能
        let draggedItem = null;
        
        function initializeDragAndDrop() {
            const container = document.getElementById('linksContainer');
            const items = container.querySelectorAll('.link-item');
            
            items.forEach(item => {
                item.setAttribute('draggable', true);
                
                item.addEventListener('dragstart', (e) => {
                    draggedItem = item;
                    setTimeout(() => {
                        item.classList.add('dragging');
                    }, 0);
                });
                
                item.addEventListener('dragend', () => {
                    draggedItem = null;
                    item.classList.remove('dragging');
                });
                
                item.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    const afterElement = getDragAfterElement(container, e.clientY);
                    if (afterElement == null) {
                        container.appendChild(draggedItem);
                    } else {
                        container.insertBefore(draggedItem, afterElement);
                    }
                });
            });
        }
        
        function getDragAfterElement(container, y) {
            const draggableElements = [...container.querySelectorAll('.link-item:not(.dragging)')];
            
            return draggableElements.reduce((closest, child) => {
                const box = child.getBoundingClientRect();
                const offset = y - box.top - box.height / 2;
                
                if (offset < 0 && offset > closest.offset) {
                    return { offset: offset, element: child };
                } else {
                    return closest;
                }
            }, { offset: Number.NEGATIVE_INFINITY }).element;
        }
        
        function saveLinkOrder() {
            const container = document.getElementById('linksContainer');
            const items = container.querySelectorAll('.link-item');
            const orderedIds = Array.from(items).map(item => item.dataset.id);
            
            fetch('/admin/api/reorder-links', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderedIds: orderedIds })
            })
            .then(response => response.json())
            .then(result => {
                if (result.success) {
                    showMessage('链接顺序已保存', 'success');
                } else {
                    showMessage('保存失败: ' + result.error, 'error');
                }
            })
            .catch(error => {
                showMessage('网络错误: ' + error.message, 'error');
            });
        }
        
        // 初始化拖拽
        document.addEventListener('DOMContentLoaded', () => {
            initializeDragAndDrop();
            
            // 拖拽结束后保存顺序
            document.addEventListener('dragend', saveLinkOrder);
        });
        
        function showAddLinkForm() {
            document.getElementById('addLinkForm').classList.remove('hidden');
        }
        
        function hideAddLinkForm() {
            document.getElementById('addLinkForm').classList.add('hidden');
            document.getElementById('newLinkForm').reset();
        }
        
        // 添加新链接
        document.getElementById('newLinkForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            const formData = new FormData(this);
            const button = this.querySelector('button[type="submit"]');
            const originalText = button.textContent;
            
            button.textContent = '添加中...';
            button.disabled = true;
            
            try {
                const response = await fetch('/admin/api/add-link', {
                    method: 'POST',
                    body: formData
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showMessage('链接添加成功', 'success');
                    this.reset();
                    setTimeout(() => location.reload(), 1500);
                } else {
                    showMessage('错误: ' + result.error, 'error');
                }
            } catch (error) {
                showMessage('网络错误: ' + error.message, 'error');
            } finally {
                button.textContent = originalText;
                button.disabled = false;
            }
        });
        
        // 删除链接
        async function deleteLink(linkId) {
            if (!confirm('确定要删除这个链接吗？')) return;
            
            try {
                const response = await fetch('/admin/api/delete-link', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ linkId: linkId })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showMessage('链接删除成功', 'success');
                    setTimeout(() => location.reload(), 1500);
                } else {
                    showMessage('错误: ' + result.error, 'error');
                }
            } catch (error) {
                showMessage('网络错误: ' + error.message, 'error');
            }
        }
        
        // 编辑链接
        function editLink(linkId) {
            const linkItem = document.querySelector('.link-item[data-id="' + linkId + '"]');
            const name = linkItem.querySelector('h4').textContent;
            const url = linkItem.querySelector('.link-url').textContent;
            const description = linkItem.querySelector('.link-description') ? linkItem.querySelector('.link-description').textContent : '';
            
            document.getElementById('editLinkId').value = linkId;
            document.getElementById('editLinkName').value = name;
            document.getElementById('editLinkUrl').value = url;
            document.getElementById('editLinkDescription').value = description;
            
            document.getElementById('editLinkModal').style.display = 'flex';
        }
        
        function closeEditModal() {
            document.getElementById('editLinkModal').style.display = 'none';
            document.getElementById('editLinkForm').reset();
        }
        
        // 提交编辑
        document.getElementById('editLinkForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            const formData = new FormData(this);
            const button = this.querySelector('button[type="submit"]');
            const originalText = button.textContent;
            
            button.textContent = '保存中...';
            button.disabled = true;
            
            try {
                const response = await fetch('/admin/api/update-link', {
                    method: 'POST',
                    body: formData
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showMessage('链接更新成功', 'success');
                    closeEditModal();
                    setTimeout(() => location.reload(), 1500);
                } else {
                    showMessage('错误: ' + result.error, 'error');
                }
            } catch (error) {
                showMessage('网络错误: ' + error.message, 'error');
            } finally {
                button.textContent = originalText;
                button.disabled = false;
            }
        });
        
        // 配置表单
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
                
                if (result.success) {
                    showMessage(result.message + ' 最后更新: ' + result.lastUpdated, 'success');
                    setTimeout(() => location.reload(), 2000);
                } else {
                    showMessage('错误: ' + result.error, 'error');
                }
            } catch (error) {
                showMessage('网络错误: ' + error.message, 'error');
            } finally {
                button.textContent = originalText;
                button.disabled = false;
            }
        });
        
        async function testTelegram() {
            const button = document.querySelector('button.button-warning');
            const originalText = button.textContent;
            
            button.textContent = '发送中...';
            button.disabled = true;
            
            try {
                const response = await fetch('/admin/api/test-telegram', {
                    method: 'POST'
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showMessage(result.message, 'success');
                } else {
                    showMessage('错误: ' + result.error, 'error');
                }
            } catch (error) {
                showMessage('网络错误: ' + error.message, 'error');
            } finally {
                button.textContent = originalText;
                button.disabled = false;
            }
        }
        
        async function logout() {
            await fetch('/admin/api/logout');
            window.location.href = '/admin';
        }
        
        function showMessage(text, type) {
            const message = document.getElementById('message');
            message.textContent = text;
            message.className = 'message ' + type;
            message.style.display = 'block';
            
            setTimeout(function() {
                message.style.display = 'none';
            }, 5000);
        }
    </script>
</body>
</html>`;
}

// 主页面HTML - 支持Telegram按钮自定义配置
function getHTML(links, telegramGroup, telegramButtonText = '加入 Telegram 交流群组', telegramButtonHidden = false) {
  // 对链接进行排序
  const sortedLinks = (links || []).sort((a, b) => (a.order || 0) - (b.order || 0));
  
  // 生成链接HTML
  const linksHTML = sortedLinks.map(link => {
    return '<div class="link-card" data-id="' + link.id + '">' +
             '<div class="link-header">' +
               '<div class="link-title">' +
                 '<div class="link-icon">🔗</div>' +
                 '<h3>' + link.name + '</h3>' +
               '</div>' +
               '<div class="link-status checking" id="status-' + link.id + '">' +
                 '<span class="status-dot"></span>' +
                 '<span class="status-text">检测中...</span>' +
               '</div>' +
             '</div>' +
             (link.description ? '<div class="link-description">' + link.description + '</div>' : '') +
             '<div class="link-url-container">' +
               '<div class="link-url" id="url-' + link.id + '">' + link.url + '</div>' +
               '<button class="copy-btn" data-link-id="' + link.id + '">' +
                 '<span class="copy-text">复制</span>' +
                 '<span class="copied-text">✅ 已复制</span>' +
               '</button>' +
             '</div>' +
             '<div class="link-meta" id="meta-' + link.id + '">最后更新: 检测中...</div>' +
           '</div>';
  }).join('');

  // 生成Telegram按钮HTML（根据配置决定是否显示）
  const telegramButtonHTML = telegramButtonHidden ? '' : 
    '<div class="actions">' +
      '<a href="' + telegramGroup + '" target="_blank" id="tgButton" class="button button-cyan">' +
        '<span>📢 ' + telegramButtonText + '</span>' +
      '</a>' +
    '</div>';

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
            --bg-gray: #f8fafc;
            --border-color: #e5e7eb;
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
            padding: 20px;
            line-height: 1.6;
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
        }

        .main-card {
            background: var(--bg-white);
            border-radius: 24px;
            padding: 2.5rem 2rem;
            width: 100%;
            box-shadow: var(--shadow-lg);
            position: relative;
            overflow: hidden;
            margin-bottom: 2rem;
        }

        .main-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 5px;
            background: var(--primary-gradient);
        }

        .header {
            text-align: center;
            margin-bottom: 2rem;
        }

        .icon {
            width: 72px;
            height: 72px;
            background: var(--primary-gradient);
            border-radius: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0 auto 1.5rem;
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
            margin-bottom: 0.5rem;
            letter-spacing: -0.5px;
            line-height: 1.2;
        }

        .subtitle {
            color: var(--text-secondary);
            font-size: 1.1rem;
            margin-bottom: 0.5rem;
        }

        .links-container {
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .link-card {
            background: var(--bg-white);
            border-radius: 16px;
            padding: 1.5rem;
            border: 2px solid var(--border-color);
            transition: all 0.3s ease;
            box-shadow: var(--shadow-sm);
        }

        .link-card:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow-md);
            border-color: #667eea;
        }

        .link-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1rem;
            flex-wrap: wrap;
            gap: 1rem;
        }

        .link-title {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .link-icon {
            font-size: 1.5rem;
        }

        .link-title h3 {
            font-size: 1.25rem;
            color: var(--text-primary);
            margin: 0;
        }

        .link-status {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.5rem 1rem;
            border-radius: 20px;
            font-size: 0.875rem;
            font-weight: 600;
            min-width: 120px;
            justify-content: center;
        }

        .link-status.checking {
            background: #fef3c7;
            color: #92400e;
        }

        .link-status.active {
            background: #d1fae5;
            color: #065f46;
        }

        .link-status.inactive {
            background: #fee2e2;
            color: #991b1b;
        }

        .link-status.error {
            background: #fef3c7;
            color: #92400e;
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
        }

        .link-status.checking .status-dot {
            background: #f59e0b;
            animation: pulse 1.5s infinite;
        }

        .link-status.active .status-dot {
            background: #10b981;
        }

        .link-status.inactive .status-dot {
            background: #ef4444;
        }

        .link-status.error .status-dot {
            background: #f59e0b;
        }

        .link-description {
            color: var(--text-secondary);
            font-size: 0.95rem;
            margin-bottom: 1rem;
            line-height: 1.5;
            padding-left: 2.25rem;
        }

        .link-url-container {
            display: flex;
            gap: 1rem;
            margin-bottom: 0.75rem;
            align-items: center;
            flex-wrap: wrap;
        }

        .link-url {
            flex: 1;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
            font-size: 0.875rem;
            color: var(--text-secondary);
            background: var(--bg-gray);
            padding: 0.875rem 1rem;
            border-radius: 12px;
            word-break: break-all;
            min-width: 200px;
            border: 1px solid var(--border-color);
        }

        .copy-btn {
            padding: 0.875rem 1.5rem;
            background: var(--primary-gradient);
            color: white;
            border: none;
            border-radius: 12px;
            font-size: 0.875rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            min-width: 100px;
            position: relative;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .copy-btn:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow-md);
        }

        .copy-btn.copied {
            background: linear-gradient(135deg, var(--success-color) 0%, #059669 100%);
        }

        .copy-text, .copied-text {
            transition: opacity 0.3s ease;
        }

        .copied-text {
            position: absolute;
            opacity: 0;
        }

        .copy-btn.copied .copy-text {
            opacity: 0;
        }

        .copy-btn.copied .copied-text {
            opacity: 1;
        }

        .link-meta {
            font-size: 0.75rem;
            color: var(--text-secondary);
            text-align: right;
            padding-left: 2.25rem;
        }

        .actions {
            display: flex;
            gap: 1rem;
            flex-wrap: wrap;
        }

        .button {
            flex: 1;
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
            text-decoration: none;
            color: white;
            min-height: 56px;
            box-shadow: var(--shadow-sm);
        }

        .button-cyan {
            background: linear-gradient(135deg, #0891b2 0%, #06b6d4 100%);
        }

        .button-cyan:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(8, 145, 178, 0.3);
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
            background: var(--bg-gray);
            text-align: center;
            width: 100%;
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
            text-align: center;
        }

        .pulse {
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.05); }
            100% { transform: scale(1); }
        }

        @keyframes rotate {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }

        /* 平板端优化 */
        @media (max-width: 768px) {
            body {
                padding: 16px;
            }
            
            .main-card {
                padding: 2rem 1.5rem;
                border-radius: 20px;
            }
            
            .icon {
                width: 64px;
                height: 64px;
                margin-bottom: 1.25rem;
            }
            
            .icon svg {
                width: 32px;
                height: 32px;
            }
            
            h1 {
                font-size: 2rem;
            }
            
            .subtitle {
                font-size: 1rem;
            }
            
            .link-header {
                flex-direction: column;
                align-items: flex-start;
                gap: 0.75rem;
            }
            
            .link-url-container {
                flex-direction: column;
                align-items: stretch;
            }
            
            .link-url {
                min-width: auto;
            }
            
            .copy-btn {
                width: 100%;
            }
            
            .button {
                min-height: 52px;
            }
        }

        /* 移动端优化 */
        @media (max-width: 480px) {
            body {
                padding: 12px;
            }
            
            .main-card {
                padding: 1.75rem 1.25rem;
                border-radius: 20px;
                margin-bottom: 1.5rem;
            }
            
            .icon {
                width: 60px;
                height: 60px;
                margin-bottom: 1rem;
                border-radius: 16px;
            }
            
            .icon svg {
                width: 28px;
                height: 28px;
            }
            
            h1 {
                font-size: 1.75rem;
            }
            
            .subtitle {
                font-size: 0.95rem;
            }
            
            .link-card {
                padding: 1.25rem;
            }
            
            .link-title h3 {
                font-size: 1.125rem;
            }
            
            .link-status {
                width: 100%;
                min-width: auto;
            }
            
            .link-description {
                padding-left: 0;
                margin-top: 0.5rem;
            }
            
            .link-meta {
                padding-left: 0;
                text-align: left;
            }
            
            .actions {
                flex-direction: column;
            }
            
            .button {
                width: 100%;
            }
            
            .admin-link {
                margin: 1rem 0 0.5rem;
                font-size: 0.85rem;
            }
            
            .footer {
                font-size: 0.75rem;
            }
        }

        /* 小屏手机优化 */
        @media (max-width: 360px) {
            .main-card {
                padding: 1.5rem 1rem;
                border-radius: 18px;
            }
            
            h1 {
                font-size: 1.5rem;
            }
            
            .icon {
                width: 56px;
                height: 56px;
            }
        }

        /* 超大屏幕优化 */
        @media (min-width: 1200px) {
            .container {
                max-width: 900px;
            }
            
            .main-card {
                padding: 3rem 2.5rem;
            }
        }
        
        /* 链接数量多时的优化 */
        @media (max-height: 800px) and (min-width: 768px) {
            .links-container {
                max-height: 60vh;
                overflow-y: auto;
                padding-right: 0.5rem;
            }
            
            .links-container::-webkit-scrollbar {
                width: 6px;
            }
            
            .links-container::-webkit-scrollbar-track {
                background: #f1f1f1;
                border-radius: 3px;
            }
            
            .links-container::-webkit-scrollbar-thumb {
                background: #c1c1c1;
                border-radius: 3px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="main-card">
            <div class="header">
                <div class="icon pulse">
                    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z"/>
                    </svg>
                </div>
                
                <h1>Hello Snippets!</h1>
                <p class="subtitle">多订阅链接管理，选择适合您的服务</p>
            </div>
            
            ${sortedLinks.length > 0 ? '<div class="links-container" id="linksContainer">' + linksHTML + '</div>' : 
              '<div class="links-container">' +
                '<div class="link-card" style="text-align: center; padding: 3rem 2rem;">' +
                  '<div class="icon" style="margin: 0 auto 1rem;">' +
                    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
                      '<path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z"/>' +
                    '</svg>' +
                  '</div>' +
                  '<h3 style="color: var(--text-primary); margin-bottom: 0.5rem;">暂无订阅链接</h3>' +
                  '<p style="color: var(--text-secondary);">请管理员在管理面板中添加订阅链接</p>' +
                '</div>' +
              '</div>'}
            
            ${telegramButtonHTML}
            
            <a href="/admin" class="admin-link">管理面板</a>
            
            <div class="footer">
                Powered by Cloudflare Workers | 多订阅链接管理
            </div>
        </div>
    </div>

    <script>
        const links = ${JSON.stringify(sortedLinks)};
        
        // 上报统计事件
        async function recordStat(type, linkId = null) {
            try {
                await fetch('/api/stats', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: type, linkId: linkId })
                });
            } catch (error) {
                console.log('统计上报失败:', error);
            }
        }
        
        async function checkLinksStatus() {
            try {
                const response = await fetch('/api/check-links');
                const data = await response.json();
                
                if (data.links && Array.isArray(data.links)) {
                    data.links.forEach(link => {
                        const statusElement = document.getElementById('status-' + link.id);
                        const metaElement = document.getElementById('meta-' + link.id);
                        
                        if (statusElement && metaElement) {
                            // 更新状态
                            statusElement.className = 'link-status ' + (link.active ? 'active' : 'inactive');
                            statusElement.querySelector('.status-text').textContent = 
                                link.active ? '🟢 服务正常' : '🔴 服务异常';
                            
                            // 更新元数据
                            let metaText = '最后更新: ' + (link.lastModified || '未知');
                            if (link.error) {
                                metaText += ' | 错误: ' + link.error;
                            } else if (link.status) {
                                metaText += ' | 状态码: ' + link.status;
                            }
                            metaElement.textContent = metaText;
                        }
                    });
                }
            } catch (error) {
                console.error('检查链接状态失败:', error);
                // 更新所有链接状态为检查失败
                document.querySelectorAll('.link-status').forEach(statusElement => {
                    statusElement.className = 'link-status error';
                    statusElement.querySelector('.status-text').textContent = '检查失败';
                });
            }
        }
        
        // 复制功能
        document.addEventListener('click', function(e) {
            if (e.target.closest('.copy-btn')) {
                const button = e.target.closest('.copy-btn');
                const linkId = button.dataset.linkId;
                const urlElement = document.getElementById('url-' + linkId);
                
                if (urlElement) {
                    const url = urlElement.textContent;
                    
                    navigator.clipboard.writeText(url).then(function() {
                        button.classList.add('copied');
                        
                        // 上报统计
                        recordStat('copy_clicks', linkId);
                        
                        setTimeout(function() {
                            button.classList.remove('copied');
                        }, 2000);
                    }).catch(function(err) {
                        console.error('复制失败:', err);
                        button.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
                        button.querySelector('.copy-text').textContent = '复制失败';
                        
                        setTimeout(function() {
                            button.style.background = '';
                            button.querySelector('.copy-text').textContent = '复制';
                        }, 2000);
                    });
                }
            }
        });
        
        // TG按钮点击统计（如果存在）
        const tgButton = document.getElementById('tgButton');
        if (tgButton) {
            tgButton.addEventListener('click', function() {
                recordStat('telegram_clicks');
            });
        }
        
        // 页面加载时检查状态
        window.addEventListener('DOMContentLoaded', function() {
            checkLinksStatus();
            
            // 每30秒自动检查状态
            setInterval(checkLinksStatus, 30000);
            
            // 为每个链接添加初始状态检查动画
            links.forEach(link => {
                const statusElement = document.getElementById('status-' + link.id);
                if (statusElement) {
                    const dot = statusElement.querySelector('.status-dot');
                    if (dot) {
                        // 添加呼吸动画
                        dot.style.animation = 'pulse 1.5s infinite';
                    }
                }
            });
        });
        
        // 平滑滚动效果
        document.querySelectorAll('a[href^="#"]').forEach(anchor => {
            anchor.addEventListener('click', function (e) {
                e.preventDefault();
                const targetId = this.getAttribute('href');
                if (targetId && targetId !== '#') {
                    const targetElement = document.querySelector(targetId);
                    if (targetElement) {
                        targetElement.scrollIntoView({
                            behavior: 'smooth',
                            block: 'start'
                        });
                    }
                }
            });
        });
    </script>
</body>
</html>`;
}