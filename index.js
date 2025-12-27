const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const express = require('express');
const cron = require('node-cron');
require('dotenv').config();

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
    ],
});

// Configuration
const GUILD_ID = process.env.GUILD_ID;
const ROLE_IDS = {
    monthly: process.env.MONTHLY_ROLE_ID,
    quarterly: process.env.QUARTERLY_ROLE_ID,
    lifetime: process.env.LIFETIME_ROLE_ID,
};

// Initialize Express server
const app = express();
app.use(express.json());

// Bot ready event
client.once('ready', () => {
    console.log(`✅ Bot logged in as ${client.user.tag}`);
    console.log(`📊 Serving ${client.guilds.cache.size} servers`);
    startExpiryMonitor();
});

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        bot: client.user ? client.user.tag : 'not ready',
        uptime: process.uptime(),
    });
});

// Delivery endpoint
app.post('/deliver', async (req, res) => {
    const { discord_id, discord_username, license_key, download_url, plan_type, email } = req.body;

    console.log(`📨 Delivery request for ${discord_username} (${discord_id})`);

    if (!discord_id || !license_key) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const user = await client.users.fetch(discord_id);

        let isInServer = false;
        let inviteLink = null;
        let roleAssigned = false;

        // Check if user is in server
        if (GUILD_ID) {
            try {
                const guild = await client.guilds.fetch(GUILD_ID);

                try {
                    const member = await guild.members.fetch(discord_id);
                    isInServer = true;
                    console.log(`✅ User in server - assigning role`);

                    // Assign role
                    if (ROLE_IDS[plan_type]) {
                        const role = await guild.roles.fetch(ROLE_IDS[plan_type]);
                        if (role) {
                            await member.roles.add(role);
                            roleAssigned = true;
                            console.log(`✅ Role assigned`);
                        }
                    }
                } catch {
                    // User not in server - create invite
                    console.log(`⚠️ User not in server - creating invite`);
                    const channels = await guild.channels.fetch();
                    const textChannel = channels.find(ch =>
                        ch.type === 0 && ch.permissionsFor(guild.members.me).has('CreateInstantInvite')
                    );

                    if (textChannel) {
                        const invite = await textChannel.createInvite({
                            maxAge: 86400, // 24 hours
                            maxUses: 1,
                            unique: true,
                            reason: `${plan_type} purchase - ${discord_username}`
                        });
                        inviteLink = invite.url;
                        console.log(`✅ Invite created`);
                    }
                }
            } catch (err) {
                console.error('Guild error:', err.message);
            }
        }

        // Build message
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🎉 Payment Successful - PropQuant.ai!')
            .setDescription(
                isInServer
                    ? 'Your EA access is now active!'
                    : 'Your EA access is ready! Join our Discord to get started.'
            )
            .addFields(
                { name: '🔑 License Key', value: `\`\`\`${license_key}\`\`\``, inline: false },
                { name: '📱 Plan', value: plan_type.charAt(0).toUpperCase() + plan_type.slice(1), inline: true },
                { name: '📧 Email', value: email || 'Not provided', inline: true }
            );

        // Add invite if not in server
        if (!isInServer && inviteLink) {
            embed.addFields({
                name: '🔗 Join Our Private Server',
                value:
                    `**[Click here to join](${inviteLink})**\n\n` +
                    `⚠️ Link expires in 24 hours\n` +
                    `After joining, you'll get:\n` +
                    `• Exclusive ${plan_type} member access\n` +
                    `• Trading signals & support\n` +
                    `• Direct access to our team`,
                inline: false
            });
        }

        // Confirm role if assigned
        if (roleAssigned) {
            embed.addFields({
                name: '✨ Community Access',
                value: `You've been added to the ${plan_type} members group!\nCheck the exclusive channels!`,
                inline: false
            });
        }

        // Download link
        if (download_url) {
            embed.addFields({
                name: '⬇️ Download EA',
                value: `[Click here to download](${download_url})\n⏰ Expires in 1 hour`,
                inline: false
            });
        }

        // Instructions
        embed.addFields({
            name: '📖 Next Steps',
            value: isInServer
                ? '1️⃣ Download EA above\n2️⃣ Place in MT5: `MQL5/Experts/`\n3️⃣ Restart MT5\n4️⃣ Drag EA to chart\n5️⃣ Enter license key'
                : '1️⃣ **Join Discord (link above)**\n2️⃣ Download EA\n3️⃣ Place in `MQL5/Experts/`\n4️⃣ Restart MT5\n5️⃣ Enter license key',
            inline: false
        });

        embed.setFooter({ text: 'PropQuant.ai - Automated Trading Excellence' }).setTimestamp();

        await user.send({ embeds: [embed] });
        console.log(`✅ DM sent to ${discord_username}`);

        res.json({
            success: true,
            message: isInServer ? 'Role assigned' : 'Invite sent',
            in_server: isInServer,
            role_assigned: roleAssigned,
            invite_created: !!inviteLink
        });

    } catch (error) {
        console.error('❌ Failed:', error.message);

        if (error.code === 50007) {
            return res.status(403).json({ error: 'User has DMs disabled' });
        }
        if (error.code === 10013) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.status(500).json({ error: error.message });
    }
});

// Expiry monitoring (placeholder - would need Supabase integration)
function startExpiryMonitor() {
    cron.schedule('0 9 * * *', () => {
        console.log('⏰ Daily license check');
    });
    console.log('✅ Expiry monitor started');
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});

// Login
client.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => console.log('🔐 Logging in to Discord...'))
    .catch(err => {
        console.error('❌ Login failed:', err.message);
        process.exit(1);
    });

// Error handlers
client.on('error', error => console.error('Discord error:', error));
process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));
