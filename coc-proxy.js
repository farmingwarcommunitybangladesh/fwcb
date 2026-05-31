/**
 * Clash of Clans API Proxy Server
 * 
 * This lightweight proxy sits between the FWCB frontend and the
 * official Clash of Clans API, protecting the API key and handling
 * CORS. Deploy to any Node.js host (Render, Railway, VPS, etc.).
 * 
 * Setup:
 *   1. npm init -y && npm install express cors node-fetch
 *   2. Set COC_API_TOKEN in your environment variables
 *   3. node coc-proxy.js
 * 
 * CoC API Token: Create one at https://developer.clashofclans.com
 */

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;
const COC_API_TOKEN = process.env.COC_API_TOKEN || '';
const COC_BASE = 'https://api.clashofclans.com/v1';

// ── CORS: allow all origins (public proxy, no auth) ───────────
app.use(cors({ origin: '*' }));

app.use(express.json());

// ── Health check ──────────────────────────────────────────────
app.get('/', (_req, res) => {
    res.json({ status: 'ok', service: 'FWCB CoC API Proxy', version: '2.0.0', note: 'capitalHallLevel from /capitalraidseasons, default null' });
});

// ── IP check: returns server's outbound IP ────────────────────
app.get('/ip', async (_req, res) => {
    try {
        const resp = await fetch('https://api.ipify.org?format=json');
        const data = await resp.json();
        res.json({ outboundIP: data.ip, hint: 'Add this IP to CoC Developer Portal allowed list' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to detect IP', detail: err.message });
    }
});

// ── Helper: call CoC API ──────────────────────────────────────
async function cocFetch(endpoint) {
    if (!COC_API_TOKEN) {
        throw new Error('COC_API_TOKEN not configured on server');
    }
    const url = `${COC_BASE}${endpoint}`;
    const resp = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${COC_API_TOKEN}`,
            'Accept': 'application/json'
        }
    });

    if (!resp.ok) {
        const body = await resp.text();
        const err = new Error(`CoC API ${resp.status}: ${body}`);
        err.status = resp.status;
        throw err;
    }

    return resp.json();
}

// ── GET /api/clan/:tag ────────────────────────────────────────
// Returns: clan info + member list + actual capital hall level
app.get('/api/clan/:tag', async (req, res) => {
    try {
        const tag = encodeURIComponent('#' + req.params.tag.toUpperCase().replace(/^#/, ''));
        const clanData = await cocFetch(`/clans/${tag}`);

        // Fetch capital hall level from raid seasons (actual building level, not league name)
        let capitalHallLevel = null;
        try {
            const raidData = await cocFetch(`/clans/${tag}/capitalraidseasons?limit=1`);
            if (raidData.items && raidData.items.length > 0) {
                capitalHallLevel = raidData.items[0].capitalHallLevel || null;
            }
        } catch (e) { /* ignore — capitalHallLevel stays null */ }

        res.json({
            success: true,
            data: {
                name: clanData.name,
                tag: clanData.tag,
                badgeUrl: clanData.badgeUrls?.medium || null,
                level: clanData.clanLevel,
                capitalHallLevel: capitalHallLevel,
                members: clanData.members,
                type: clanData.type,
                description: clanData.description,
                location: clanData.location?.name || 'International',
                warFrequency: clanData.warFrequency,
                warWinStreak: clanData.warWinStreak,
                warWins: clanData.warWins,
                warTies: clanData.warTies,
                warLosses: clanData.warLosses,
                clanPoints: clanData.clanPoints,
                clanBuilderBasePoints: clanData.clanBuilderBasePoints,
                clanCapitalPoints: clanData.clanCapitalPoints,
                capitalLeague: clanData.capitalLeague?.name || 'Unranked',
                requiredTrophies: clanData.requiredTrophies,
                warLeague: clanData.warLeague?.name || 'Unranked',
                memberList: (clanData.memberList || []).map(m => ({
                    name: m.name,
                    tag: m.tag,
                    role: m.role,
                    trophies: m.trophies,
                    builderBaseTrophies: m.builderBaseTrophies,
                    donations: m.donations,
                    donationsReceived: m.donationsReceived,
                    expLevel: m.expLevel,
                    townHallLevel: m.townHallLevel || 'N/A',
                    league: m.league?.name || 'Unranked',
                    leagueIcon: m.league?.iconUrls?.small || null
                })).sort((a, b) => {
                    const roleOrder = { 'leader': 0, 'coleader': 1, 'admin': 2, 'elder': 2, 'member': 3 };
                    return (roleOrder[a.role] ?? 4) - (roleOrder[b.role] ?? 4);
                })
            }
        });
    } catch (err) {
        console.error(`[/api/clan] Error for ${req.params.tag}:`, err.message);
        res.status(err.status || 500).json({
            success: false,
            error: err.message
        });
    }
});

// ── GET /api/clan/:tag/war ────────────────────────────────────
// Returns: current war (clan vs clan, individual attacks)
app.get('/api/clan/:tag/war', async (req, res) => {
    try {
        const tag = encodeURIComponent('#' + req.params.tag.toUpperCase().replace(/^#/, ''));
        const warData = await cocFetch(`/clans/${tag}/currentwar`);

        if (warData.state === 'notInWar') {
            return res.json({ success: true, data: { state: 'notInWar' } });
        }

        if (warData.state === 'preparation') {
            return res.json({
                success: true,
                data: {
                    state: 'preparation',
                    teamSize: warData.teamSize,
                    startTime: warData.startTime,
                    opponent: {
                        name: warData.opponent?.name || 'Unknown',
                        tag: warData.opponent?.tag || '',
                        level: warData.opponent?.clanLevel || 0
                    }
                }
            });
        }

        // In war or war ended
        const isCwl = warData.leagueGroup ? true : false;
        const ourClan = (warData.clan?.tag?.replace(/^#/, '') || '') === req.params.tag.toUpperCase().replace(/^#/, '')
            ? warData.clan : warData.opponent;

        const opponentClan = (warData.clan?.tag?.replace(/^#/, '') || '') === req.params.tag.toUpperCase().replace(/^#/, '')
            ? warData.opponent : warData.clan;

        res.json({
            success: true,
            data: {
                state: warData.state,
                teamSize: warData.teamSize,
                isCWL: isCwl,
                startTime: warData.startTime,
                endTime: warData.endTime,
                clan: {
                    name: ourClan?.name || 'Unknown',
                    tag: ourClan?.tag || '',
                    level: ourClan?.clanLevel || 0,
                    stars: ourClan?.stars || 0,
                    destructionPercentage: ourClan?.destructionPercentage || 0,
                    attacks: ourClan?.attacks || 0,
                    members: (ourClan?.members || []).map(m => ({
                        name: m.name,
                        tag: m.tag,
                        townHallLevel: m.townhallLevel || 'N/A',
                        mapPosition: m.mapPosition,
                        opponentAttacks: m.opponentAttacks || 0,
                        bestOpponentAttack: m.bestOpponentAttack
                            ? {
                                stars: m.bestOpponentAttack.stars,
                                destructionPercentage: m.bestOpponentAttack.destructionPercentage,
                                duration: m.bestOpponentAttack.duration
                            }
                            : null,
                        attacks: (m.attacks || []).map(a => ({
                            stars: a.stars,
                            destructionPercentage: a.destructionPercentage,
                            duration: a.duration,
                            defenderTag: a.defenderTag,
                            defenderName: a.defenderName || a.defenderTag || 'Unknown',
                            defenderMapPosition: a.defenderMapPosition
                        }))
                    }))
                },
                opponent: {
                    name: opponentClan?.name || 'Unknown',
                    tag: opponentClan?.tag || '',
                    level: opponentClan?.clanLevel || 0,
                    stars: opponentClan?.stars || 0,
                    destructionPercentage: opponentClan?.destructionPercentage || 0,
                    attacks: opponentClan?.attacks || 0
                }
            }
        });
    } catch (err) {
        // 403 often means war log is private — not an error we should crash on
        if (err.status === 403) {
            return res.json({ success: true, data: { state: 'privateWarLog' } });
        }
        console.error(`[/api/clan/:tag/war] Error for ${req.params.tag}:`, err.message);
        res.status(err.status || 500).json({
            success: false,
            error: err.message
        });
    }
});

// ── GET /api/clan/:tag/warlog ─────────────────────────────────
// Returns: recent war log (last 10 wars)
app.get('/api/clan/:tag/warlog', async (req, res) => {
    try {
        const tag = encodeURIComponent('#' + req.params.tag.toUpperCase().replace(/^#/, ''));
        const warLogData = await cocFetch(`/clans/${tag}/warlog?limit=10`);

        res.json({
            success: true,
            data: (warLogData.items || []).map(war => {
                const isWinner = war.result === 'win';
                return {
                    result: war.result,
                    teamSize: war.teamSize,
                    opponent: {
                        name: war.opponent?.name || 'Unknown',
                        tag: war.opponent?.tag || '',
                        level: war.opponent?.clanLevel || 0
                    },
                    clan: {
                        stars: war.clan?.stars || 0,
                        destructionPercentage: war.clan?.destructionPercentage || 0
                    },
                    opponentStars: war.opponent?.stars || 0,
                    opponentDestruction: war.opponent?.destructionPercentage || 0,
                    isWinner: isWinner,
                    endTime: war.endTime
                };
            })
        });
    } catch (err) {
        if (err.status === 403) {
            return res.json({ success: true, data: 'privateWarLog' });
        }
        console.error(`[/api/clan/:tag/warlog] Error for ${req.params.tag}:`, err.message);
        res.status(err.status || 500).json({
            success: false,
            error: err.message
        });
    }
});

// ── POST /api/clans/badges ────────────────────────────────────
// Accepts { tags: ["tag1","tag2",...] } and returns a map of tag→{badgeUrl, capitalHallLevel}
app.post('/api/clans/badges', async (req, res) => {
    try {
        const { tags } = req.body;
        if (!Array.isArray(tags) || tags.length === 0) {
            return res.json({ success: true, badges: {} });
        }
        const badges = {};
        const results = await Promise.allSettled(
            tags.map(async (tag) => {
                const encoded = encodeURIComponent('#' + tag.toUpperCase().replace(/^#/, ''));
                const data = await cocFetch(`/clans/${encoded}`);
                // Also fetch capital hall level
                let capitalHallLevel = null;
                try {
                    const raidData = await cocFetch(`/clans/${encoded}/capitalraidseasons?limit=1`);
                    if (raidData.items && raidData.items.length > 0) {
                        capitalHallLevel = raidData.items[0].capitalHallLevel || null;
                    }
                } catch (e) { /* ignore — capitalHallLevel stays null */ }
                return { tag, badgeUrl: data.badgeUrls?.medium || null, capitalHallLevel };
            })
        );
        results.forEach(r => {
            if (r.status === 'fulfilled' && r.value) {
                badges[r.value.tag] = { badgeUrl: r.value.badgeUrl, capitalHallLevel: r.value.capitalHallLevel };
            }
        });
        res.json({ success: true, badges });
    } catch (err) {
        console.error('[/api/clans/badges] Error:', err.message);
        res.status(err.status || 500).json({ success: false, error: err.message });
    }
});

// ── 404 handler ───────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[FWCB Proxy] CoC API proxy running on port ${PORT}`);
    if (!COC_API_TOKEN) {
        console.warn('[FWCB Proxy] ⚠  COC_API_TOKEN not set! Set it as an environment variable.');
    }
});
