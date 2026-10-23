#!/usr/bin/env gjs -m
// Standalone libadwaita process for the monthly report (GNOME Shell cannot
// host GTK windows). Launched as: gjs -m report/main.js [projectId]
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gettext from 'gettext';

import {Config, settingsFromDirectory} from '../core/config.js';
import {GitLabClient} from '../core/gitlabClient.js';
import {IssueSource} from '../core/issueSource.js';
import {ReportWindow} from './reportWindow.js';

const DOMAIN = 'timelogs-extension@heno-dm.github.io';
const [scriptPath] = GLib.filename_from_uri(import.meta.url);
const root = GLib.path_get_dirname(GLib.path_get_dirname(scriptPath));

Gettext.bindtextdomain(DOMAIN, GLib.build_filenamev([root, 'locale']));
const _ = Gettext.domain(DOMAIN).gettext;

const app = new Adw.Application({
    application_id: 'io.github.heno_dm.TimelogsExtension.Report',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});

app.connect('activate', application => {
    const settings = settingsFromDirectory(GLib.build_filenamev([root, 'schemas']));
    const config = new Config(settings);
    config.migrate();
    const client = new GitLabClient({url: config.url, token: settings.get_string('gitlab-token')});
    const issues = new IssueSource({client, config});
    const projectIdArg = ARGV[0] ? Number(ARGV[0]) : null;
    const window = new ReportWindow({
        application,
        config,
        client,
        issues,
        gettext: _,
        preselectedProjectId: Number.isFinite(projectIdArg) && projectIdArg > 0 ? projectIdArg : null,
    });
    window.present();
    config.getToken().then(token => {
        client.setCredentials({url: config.url, token});
        issues.invalidate();
        window.start();
    });
});

app.run([]);
