import * as fs from 'fs';
import * as path from 'path';
import { OutputChannel, QuickPickItem, Uri } from 'vscode';
import { IInstaller, Product } from '../../common/types';
import { TestConfigurationManager } from '../common/managers/testConfigurationManager';
import { ITestConfigSettingsService } from '../common/types';

export class ConfigurationManager extends TestConfigurationManager {
    constructor(workspace: Uri, outputChannel: OutputChannel,
        installer: IInstaller, testConfigSettingsService: ITestConfigSettingsService) {
        super(workspace, Product.pytest, outputChannel, installer, testConfigSettingsService);
    }
    private static async configFilesExist(rootDir: string): Promise<string[]> {
        const promises = ['pytest.ini', 'tox.ini', 'setup.cfg'].map(cfg => {
            return new Promise<string>(resolve => {
                fs.exists(path.join(rootDir, cfg), exists => { resolve(exists ? cfg : ''); });
            });
        });
        const values = await Promise.all(promises);
        return values.filter(exists => exists.length > 0);
    }
    // tslint:disable-next-line:no-any
    public async configure(wkspace: Uri) {
        const args: string[] = [];
        const configFileOptionLabel = 'Use existing config file';
        const options: QuickPickItem[] = [];
        const configFiles = await ConfigurationManager.configFilesExist(wkspace.fsPath);
        // If a config file exits, there's nothing to be configured.
        if (configFiles.length > 0 && configFiles.length !== 1 && configFiles[0] !== 'setup.cfg') {
            return;
        }

        if (configFiles.length === 1 && configFiles[0] === 'setup.cfg') {
            options.push({
                label: configFileOptionLabel,
                description: 'setup.cfg'
            });
        }
        const subDirs = await this.getTestDirs(wkspace.fsPath);
        const testDir = await this.selectTestDir(wkspace.fsPath, subDirs, options);
        if (typeof testDir === 'string' && testDir !== configFileOptionLabel) {
            args.push(testDir);
        }
        const installed = await this.installer.isInstalled(Product.pytest);
        if (!installed) {
            await this.installer.install(Product.pytest);
        }
        await this.testConfigSettingsService.updateTestArgs(wkspace.fsPath, Product.pytest, args);
    }
}
