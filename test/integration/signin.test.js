const request = require('supertest');
const nock = require('nock');

const helper = require('.');
const fixtures = require('../fixtures');

const { probot, slackbot } = helper;

const { SlackWorkspace } = helper.robot.models;

const promptUrl = /^http:\/\/127\.0\.0\.1:\d+(\/github\/oauth\/login\?state=(.*))/;

describe('Integration: signin', () => {
  beforeEach(async () => {
    // create workspace
    await SlackWorkspace.create({
      slackId: 'T0001',
      accessToken: 'xoxp-token',
    });
  });

  describe('unauthenticated user', () => {
    test('is prompted to authenticate', async () => {
      // User types slash command
      const command = fixtures.slack.command({
        text: 'signin',
      });
      const res = await request(probot.server).post('/slack/command')
        .use(slackbot)
        .send(command)
        .expect(200);

      // User is shown ephemeral prompt to authenticate
      const { text, url } = res.body.attachments[0].actions[0];
      expect(text).toMatch('Connect GitHub account');
      expect(url).toMatch(promptUrl);

      // User follows link to OAuth
      const [, link, state] = url.match(promptUrl);

      const loginRequest = request(probot.server).get(link);
      await loginRequest.expect(302).expect(
        'Location',
        `https://github.com/login/oauth/authorize?client_id=&state=${state}`,
      );

      // GitHub redirects back, authenticates user and process subscription
      nock('https://github.com').post('/login/oauth/access_token')
        .reply(200, fixtures.github.oauth);
      nock('https://api.github.com').get('/user')
        .reply(200, fixtures.user);

      nock('https://hooks.slack.com').post('/commands/1234/5678', {
        response_type: 'ephemeral',
        attachments: [{
          text: `:white_check_mark: Success! <@${command.user_id}> is now connected to <${fixtures.user.html_url}|@${fixtures.user.login}>`,
        }],
      }).reply(200);

      await request(probot.server).get('/github/oauth/callback').query({ state })
        .expect(302)
        .expect(
          'Location',
          `https://slack.com/app_redirect?team=${command.team_id}&channel=${command.channel_id}`,
        );
    });
  });

  describe('with a pending subscription', () => {
    test.only('rediects to install app', async () => {
      const agent = request.agent(probot.server);

      // User types slash command
      const command = fixtures.slack.command({
        text: 'subscribe kubernetes/kubernetes',
      });
      const res = await agent.post('/slack/command').use(slackbot).send(command)
        .expect(200);

      // User is shown ephemeral prompt to authenticate
      const { url } = res.body.attachments[0].actions[0];
      expect(url).toMatch(promptUrl);

      // Save state, we're going to need it in a minute
      const state = url.match(promptUrl)[2];

      // Pretend the user clicked the link, got redirected to GitHub and back
      nock('https://github.com').post('/login/oauth/access_token')
        .reply(200, fixtures.github.oauth);
      nock('https://api.github.com').get('/user')
        .reply(200, fixtures.user);

      // Post confirmation of signin
      nock('https://hooks.slack.com').post('/commands/1234/5678').reply(200);

      await agent.get('/github/oauth/callback').query({ state })
        .expect(302)
        .expect('Location', '/slack/command');

      // Redirects to install the GitHub App
      nock('https://api.github.com').get('/users/kubernetes').reply(200, fixtures.org);
      nock('https://api.github.com').get('/app').reply(200, fixtures.app);
      await agent.get('/slack/command')
        .expect(302)
        .expect('Location', 'https://github.com/apps/slack-bkeepers/installations/new/permissions?target_id=13629408');

      // Pretend the user goes and installs the GitHub app, and then is
      // redirected back to /setup.
      const { Installation } = helper.robot.models;
      await Installation.create({
        githubId: 1,
        ownerId: fixtures.org.id,
      });

      await agent.get('/github/setup')
        .expect(302)
        .expect('Location', '/slack/command');

      // Follow the redirect (again)
      nock('https://api.github.com').get('/users/kubernetes').reply(200, fixtures.org);

      // TODO: post to slack
      await agent.get('/slack/command')
        .expect(200);
    });
  });
});
