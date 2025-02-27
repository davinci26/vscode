/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as arrays from 'vs/base/common/arrays';
import { isFalsyOrWhitespace } from 'vs/base/common/strings';
import { isArray, withUndefinedAsNull } from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { ConfigurationTarget, IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { SettingsTarget } from 'vs/workbench/contrib/preferences/browser/preferencesWidgets';
import { ITOCEntry, knownAcronyms, knownTermMappings } from 'vs/workbench/contrib/preferences/browser/settingsLayout';
import { MODIFIED_SETTING_TAG } from 'vs/workbench/contrib/preferences/common/preferences';
import { IExtensionSetting, ISearchResult, ISetting, SettingValueType } from 'vs/workbench/services/preferences/common/preferences';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { FOLDER_SCOPES, WORKSPACE_SCOPES, REMOTE_MACHINE_SCOPES, LOCAL_MACHINE_SCOPES } from 'vs/workbench/services/configuration/common/configuration';

export const ONLINE_SERVICES_SETTING_TAG = 'usesOnlineServices';

export interface ISettingsEditorViewState {
	settingsTarget: SettingsTarget;
	tagFilters?: Set<string>;
	extensionFilters?: Set<string>;
	filterToCategory?: SettingsTreeGroupElement;
}

export abstract class SettingsTreeElement {
	id: string;
	parent?: SettingsTreeGroupElement;

	/**
	 * Index assigned in display order, used for paging.
	 */
	index: number;

	constructor(_id: string, _index: number) {
		this.id = _id;
		this.index = _index;
	}
}

export type SettingsTreeGroupChild = (SettingsTreeGroupElement | SettingsTreeSettingElement | SettingsTreeNewExtensionsElement);

export class SettingsTreeGroupElement extends SettingsTreeElement {
	count?: number;
	label: string;
	level: number;
	isFirstGroup: boolean;

	private _childSettingKeys: Set<string> = new Set();
	private _children: SettingsTreeGroupChild[] = [];

	get children(): SettingsTreeGroupChild[] {
		return this._children;
	}

	set children(newChildren: SettingsTreeGroupChild[]) {
		this._children = newChildren;

		this._childSettingKeys = new Set();
		this._children.forEach(child => {
			if (child instanceof SettingsTreeSettingElement) {
				this._childSettingKeys.add(child.setting.key);
			}
		});
	}

	constructor(_id: string, _index: number, count: number | undefined, label: string, level: number, isFirstGroup: boolean) {
		super(_id, _index);

		this.count = count;
		this.label = label;
		this.level = level;
		this.isFirstGroup = isFirstGroup;
	}

	/**
	 * Returns whether this group contains the given child key (to a depth of 1 only)
	 */
	containsSetting(key: string): boolean {
		return this._childSettingKeys.has(key);
	}
}

export class SettingsTreeNewExtensionsElement extends SettingsTreeElement {
	constructor(_id: string, _index: number, public readonly extensionIds: string[]) {
		super(_id, _index);
	}
}

export class SettingsTreeSettingElement extends SettingsTreeElement {
	private static MAX_DESC_LINES = 20;

	setting: ISetting;

	private _displayCategory: string | null = null;
	private _displayLabel: string | null = null;

	/**
	 * scopeValue || defaultValue, for rendering convenience.
	 */
	value: any;

	/**
	 * The value in the current settings scope.
	 */
	scopeValue: any;

	/**
	 * The default value
	 */
	defaultValue?: any;

	/**
	 * Whether the setting is configured in the selected scope.
	 */
	isConfigured = false;

	tags?: Set<string>;
	overriddenScopeList: string[] = [];
	description!: string;
	valueType!: SettingValueType;

	constructor(setting: ISetting, parent: SettingsTreeGroupElement, index: number, inspectResult: IInspectResult) {
		super(sanitizeId(parent.id + '_' + setting.key), index);
		this.setting = setting;
		this.parent = parent;

		this.update(inspectResult);
	}

	get displayCategory(): string {
		if (!this._displayCategory) {
			this.initLabel();
		}

		return this._displayCategory!;
	}

	get displayLabel(): string {
		if (!this._displayLabel) {
			this.initLabel();
		}

		return this._displayLabel!;
	}

	private initLabel(): void {
		const displayKeyFormat = settingKeyToDisplayFormat(this.setting.key, this.parent!.id);
		this._displayLabel = displayKeyFormat.label;
		this._displayCategory = displayKeyFormat.category;
	}

	update(inspectResult: IInspectResult): void {
		const { isConfigured, inspected, targetSelector } = inspectResult;

		const displayValue = isConfigured ? inspected[targetSelector] : inspected.default;
		const overriddenScopeList: string[] = [];
		if (targetSelector !== 'workspace' && typeof inspected.workspace !== 'undefined') {
			overriddenScopeList.push(localize('workspace', "Workspace"));
		}

		if (targetSelector !== 'userRemote' && typeof inspected.userRemote !== 'undefined') {
			overriddenScopeList.push(localize('remote', "Remote"));
		}

		if (targetSelector !== 'userLocal' && typeof inspected.userLocal !== 'undefined') {
			overriddenScopeList.push(localize('user', "User"));
		}

		this.value = displayValue;
		this.scopeValue = isConfigured && inspected[targetSelector];
		this.defaultValue = inspected.default;

		this.isConfigured = isConfigured;
		if (isConfigured || this.setting.tags || this.tags) {
			// Don't create an empty Set for all 1000 settings, only if needed
			this.tags = new Set<string>();
			if (isConfigured) {
				this.tags.add(MODIFIED_SETTING_TAG);
			}

			if (this.setting.tags) {
				this.setting.tags.forEach(tag => this.tags!.add(tag));
			}
		}

		this.overriddenScopeList = overriddenScopeList;
		if (this.setting.description.length > SettingsTreeSettingElement.MAX_DESC_LINES) {
			const truncatedDescLines = this.setting.description.slice(0, SettingsTreeSettingElement.MAX_DESC_LINES);
			truncatedDescLines.push('[...]');
			this.description = truncatedDescLines.join('\n');
		} else {
			this.description = this.setting.description.join('\n');
		}

		if (this.setting.enum && (!this.setting.type || settingTypeEnumRenderable(this.setting.type))) {
			this.valueType = SettingValueType.Enum;
		} else if (this.setting.type === 'string') {
			this.valueType = SettingValueType.String;
		} else if (isExcludeSetting(this.setting)) {
			this.valueType = SettingValueType.Exclude;
		} else if (this.setting.type === 'integer') {
			this.valueType = SettingValueType.Integer;
		} else if (this.setting.type === 'number') {
			this.valueType = SettingValueType.Number;
		} else if (this.setting.type === 'boolean') {
			this.valueType = SettingValueType.Boolean;
		} else if (this.setting.type === 'array' && this.setting.arrayItemType === 'string') {
			this.valueType = SettingValueType.ArrayOfString;
		} else if (isArray(this.setting.type) && this.setting.type.indexOf(SettingValueType.Null) > -1 && this.setting.type.length === 2) {
			if (this.setting.type.indexOf(SettingValueType.Integer) > -1) {
				this.valueType = SettingValueType.NullableInteger;
			} else if (this.setting.type.indexOf(SettingValueType.Number) > -1) {
				this.valueType = SettingValueType.NullableNumber;
			} else {
				this.valueType = SettingValueType.Complex;
			}
		} else {
			this.valueType = SettingValueType.Complex;
		}
	}

	matchesAllTags(tagFilters?: Set<string>): boolean {
		if (!tagFilters || !tagFilters.size) {
			return true;
		}

		if (this.tags) {
			let hasFilteredTag = true;
			tagFilters.forEach(tag => {
				hasFilteredTag = hasFilteredTag && this.tags!.has(tag);
			});
			return hasFilteredTag;
		} else {
			return false;
		}
	}

	matchesScope(scope: SettingsTarget, isRemote: boolean): boolean {
		const configTarget = URI.isUri(scope) ? ConfigurationTarget.WORKSPACE_FOLDER : scope;

		if (!this.setting.scope) {
			return true;
		}

		if (configTarget === ConfigurationTarget.WORKSPACE_FOLDER) {
			return FOLDER_SCOPES.indexOf(this.setting.scope) !== -1;
		}

		if (configTarget === ConfigurationTarget.WORKSPACE) {
			return WORKSPACE_SCOPES.indexOf(this.setting.scope) !== -1;
		}

		if (configTarget === ConfigurationTarget.USER_REMOTE) {
			return REMOTE_MACHINE_SCOPES.indexOf(this.setting.scope) !== -1;
		}

		if (configTarget === ConfigurationTarget.USER_LOCAL && isRemote) {
			return LOCAL_MACHINE_SCOPES.indexOf(this.setting.scope) !== -1;
		}

		return true;
	}

	matchesAnyExtension(extensionFilters?: Set<string>): boolean {
		if (!extensionFilters || !extensionFilters.size) {
			return true;
		}

		if (!this.setting.extensionInfo) {
			return false;
		}

		return Array.from(extensionFilters).some(extensionId => extensionId.toLowerCase() === this.setting.extensionInfo!.id.toLowerCase());
	}
}

export class SettingsTreeModel {
	protected _root!: SettingsTreeGroupElement;
	protected _treeElementsById = new Map<string, SettingsTreeElement>();
	private _treeElementsBySettingName = new Map<string, SettingsTreeSettingElement[]>();
	private _tocRoot!: ITOCEntry;

	constructor(
		protected _viewState: ISettingsEditorViewState,
		@IConfigurationService private readonly _configurationService: IConfigurationService
	) { }

	get root(): SettingsTreeGroupElement {
		return this._root;
	}

	update(newTocRoot = this._tocRoot): void {
		this._treeElementsById.clear();
		this._treeElementsBySettingName.clear();

		const newRoot = this.createSettingsTreeGroupElement(newTocRoot);
		if (newRoot.children[0] instanceof SettingsTreeGroupElement) {
			(<SettingsTreeGroupElement>newRoot.children[0]).isFirstGroup = true; // TODO
		}

		if (this._root) {
			this._root.children = newRoot.children;
		} else {
			this._root = newRoot;
		}
	}

	getElementById(id: string): SettingsTreeElement | null {
		return withUndefinedAsNull(this._treeElementsById.get(id));
	}

	getElementsByName(name: string): SettingsTreeSettingElement[] | null {
		return withUndefinedAsNull(this._treeElementsBySettingName.get(name));
	}

	updateElementsByName(name: string): void {
		if (!this._treeElementsBySettingName.has(name)) {
			return;
		}

		this._treeElementsBySettingName.get(name)!.forEach(element => {
			const inspectResult = inspectSetting(element.setting.key, this._viewState.settingsTarget, this._configurationService);
			element.update(inspectResult);
		});
	}

	private createSettingsTreeGroupElement(tocEntry: ITOCEntry, parent?: SettingsTreeGroupElement): SettingsTreeGroupElement {

		const index = this._treeElementsById.size;
		const depth = parent ? this.getDepth(parent) + 1 : 0;
		const element = new SettingsTreeGroupElement(tocEntry.id, index, undefined, tocEntry.label, depth, false);

		const children: SettingsTreeGroupChild[] = [];
		if (tocEntry.settings) {
			const settingChildren = tocEntry.settings.map(s => this.createSettingsTreeSettingElement(<ISetting>s, element))
				.filter(el => el.setting.deprecationMessage ? el.isConfigured : true);
			children.push(...settingChildren);
		}

		if (tocEntry.children) {
			const groupChildren = tocEntry.children.map(child => this.createSettingsTreeGroupElement(child, element));
			children.push(...groupChildren);
		}

		element.children = children;

		this._treeElementsById.set(element.id, element);
		return element;
	}

	private getDepth(element: SettingsTreeElement): number {
		if (element.parent) {
			return 1 + this.getDepth(element.parent);
		} else {
			return 0;
		}
	}

	private createSettingsTreeSettingElement(setting: ISetting, parent: SettingsTreeGroupElement): SettingsTreeSettingElement {
		const index = this._treeElementsById.size;
		const inspectResult = inspectSetting(setting.key, this._viewState.settingsTarget, this._configurationService);
		const element = new SettingsTreeSettingElement(setting, parent, index, inspectResult);
		this._treeElementsById.set(element.id, element);

		const nameElements = this._treeElementsBySettingName.get(setting.key) || [];
		nameElements.push(element);
		this._treeElementsBySettingName.set(setting.key, nameElements);
		return element;
	}
}

interface IInspectResult {
	isConfigured: boolean;
	inspected: {
		default: any,
		user: any,
		userLocal?: any,
		userRemote?: any,
		workspace?: any,
		workspaceFolder?: any,
		memory?: any,
		value: any,
	};
	targetSelector: 'userLocal' | 'userRemote' | 'workspace' | 'workspaceFolder';
}

function inspectSetting(key: string, target: SettingsTarget, configurationService: IConfigurationService): IInspectResult {
	const inspectOverrides = URI.isUri(target) ? { resource: target } : undefined;
	const inspected = configurationService.inspect(key, inspectOverrides);
	const targetSelector = target === ConfigurationTarget.USER_LOCAL ? 'userLocal' :
		target === ConfigurationTarget.USER_REMOTE ? 'userRemote' :
			target === ConfigurationTarget.WORKSPACE ? 'workspace' :
				'workspaceFolder';
	const isConfigured = typeof inspected[targetSelector] !== 'undefined';

	return { isConfigured, inspected, targetSelector };
}

function sanitizeId(id: string): string {
	return id.replace(/[\.\/]/, '_');
}

export function settingKeyToDisplayFormat(key: string, groupId = ''): { category: string, label: string; } {
	const lastDotIdx = key.lastIndexOf('.');
	let category = '';
	if (lastDotIdx >= 0) {
		category = key.substr(0, lastDotIdx);
		key = key.substr(lastDotIdx + 1);
	}

	groupId = groupId.replace(/\//g, '.');
	category = trimCategoryForGroup(category, groupId);
	category = wordifyKey(category);

	const label = wordifyKey(key);
	return { category, label };
}

function wordifyKey(key: string): string {
	key = key
		.replace(/\.([a-z0-9])/g, (_, p1) => ` › ${p1.toUpperCase()}`) // Replace dot with spaced '>'
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2') // Camel case to spacing, fooBar => foo Bar
		.replace(/^[a-z]/g, match => match.toUpperCase()) // Upper casing all first letters, foo => Foo
		.replace(/\b\w+\b/g, match => { // Upper casing known acronyms
			return knownAcronyms.has(match.toLowerCase()) ?
				match.toUpperCase() :
				match;
		});

	for (let [k, v] of knownTermMappings) {
		key = key.replace(new RegExp(`\\b${k}\\b`, 'gi'), v);
	}

	return key;
}

function trimCategoryForGroup(category: string, groupId: string): string {
	const doTrim = (forward: boolean) => {
		const parts = groupId.split('.');
		while (parts.length) {
			const reg = new RegExp(`^${parts.join('\\.')}(\\.|$)`, 'i');
			if (reg.test(category)) {
				return category.replace(reg, '');
			}

			if (forward) {
				parts.pop();
			} else {
				parts.shift();
			}
		}

		return null;
	};

	let trimmed = doTrim(true);
	if (trimmed === null) {
		trimmed = doTrim(false);
	}

	if (trimmed === null) {
		trimmed = category;
	}

	return trimmed;
}

export function isExcludeSetting(setting: ISetting): boolean {
	return setting.key === 'files.exclude' ||
		setting.key === 'search.exclude' ||
		setting.key === 'files.watcherExclude';
}

function settingTypeEnumRenderable(_type: string | string[]) {
	const enumRenderableSettingTypes = ['string', 'boolean', 'null', 'integer', 'number'];
	const type = isArray(_type) ? _type : [_type];
	return type.every(type => enumRenderableSettingTypes.indexOf(type) > -1);
}

export const enum SearchResultIdx {
	Local = 0,
	Remote = 1,
	NewExtensions = 2
}

export class SearchResultModel extends SettingsTreeModel {
	private rawSearchResults: ISearchResult[] | null = null;
	private cachedUniqueSearchResults: ISearchResult[] | null = null;
	private newExtensionSearchResults: ISearchResult | null = null;

	readonly id = 'searchResultModel';

	constructor(
		viewState: ISettingsEditorViewState,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkbenchEnvironmentService private environmentService: IWorkbenchEnvironmentService,
	) {
		super(viewState, configurationService);
		this.update({ id: 'searchResultModel', label: '' });
	}

	getUniqueResults(): ISearchResult[] {
		if (this.cachedUniqueSearchResults) {
			return this.cachedUniqueSearchResults;
		}

		if (!this.rawSearchResults) {
			return [];
		}

		const localMatchKeys = new Set();
		const localResult = this.rawSearchResults[SearchResultIdx.Local];
		if (localResult) {
			localResult.filterMatches.forEach(m => localMatchKeys.add(m.setting.key));
		}

		const remoteResult = this.rawSearchResults[SearchResultIdx.Remote];
		if (remoteResult) {
			remoteResult.filterMatches = remoteResult.filterMatches.filter(m => !localMatchKeys.has(m.setting.key));
		}

		if (remoteResult) {
			this.newExtensionSearchResults = this.rawSearchResults[SearchResultIdx.NewExtensions];
		}

		this.cachedUniqueSearchResults = [localResult, remoteResult];
		return this.cachedUniqueSearchResults;
	}

	getRawResults(): ISearchResult[] {
		return this.rawSearchResults || [];
	}

	setResult(order: SearchResultIdx, result: ISearchResult | null): void {
		this.cachedUniqueSearchResults = null;
		this.rawSearchResults = this.rawSearchResults || [];
		if (!result) {
			delete this.rawSearchResults[order];
			return;
		}

		this.rawSearchResults[order] = result;
		this.updateChildren();
	}

	updateChildren(): void {
		this.update({
			id: 'searchResultModel',
			label: 'searchResultModel',
			settings: this.getFlatSettings()
		});

		// Save time, filter children in the search model instead of relying on the tree filter, which still requires heights to be calculated.
		const isRemote = !!this.environmentService.configuration.remoteAuthority;
		this.root.children = this.root.children
			.filter(child => child instanceof SettingsTreeSettingElement && child.matchesAllTags(this._viewState.tagFilters) && child.matchesScope(this._viewState.settingsTarget, isRemote) && child.matchesAnyExtension(this._viewState.extensionFilters));

		if (this.newExtensionSearchResults && this.newExtensionSearchResults.filterMatches.length) {
			const resultExtensionIds = this.newExtensionSearchResults.filterMatches
				.map(result => (<IExtensionSetting>result.setting))
				.filter(setting => setting.extensionName && setting.extensionPublisher)
				.map(setting => `${setting.extensionPublisher}.${setting.extensionName}`);

			const newExtElement = new SettingsTreeNewExtensionsElement('newExtensions', this._treeElementsById.size, arrays.distinct(resultExtensionIds));
			newExtElement.parent = this._root;
			this._treeElementsById.set(newExtElement.id, newExtElement);
			this._root.children.push(newExtElement);
		}
	}

	private getFlatSettings(): ISetting[] {
		const flatSettings: ISetting[] = [];
		arrays.coalesce(this.getUniqueResults())
			.forEach(r => {
				flatSettings.push(
					...r.filterMatches.map(m => m.setting));
			});

		return flatSettings;
	}
}

export interface IParsedQuery {
	tags: string[];
	query: string;
	extensionFilters: string[];
}

const tagRegex = /(^|\s)@tag:("([^"]*)"|[^"]\S*)/g;
const extensionRegex = /(^|\s)@ext:("([^"]*)"|[^"]\S*)?/g;
export function parseQuery(query: string): IParsedQuery {
	const tags: string[] = [];
	let extensions: string[] = [];
	query = query.replace(tagRegex, (_, __, quotedTag, tag) => {
		tags.push(tag || quotedTag);
		return '';
	});

	query = query.replace(`@${MODIFIED_SETTING_TAG}`, () => {
		tags.push(MODIFIED_SETTING_TAG);
		return '';
	});

	query = query.replace(extensionRegex, (_, __, quotedExtensionId, extensionId) => {
		let extensionIdQuery: string = extensionId || quotedExtensionId;
		if (extensionIdQuery) {
			extensions.push(...extensionIdQuery.split(',').map(s => s.trim()).filter(s => !isFalsyOrWhitespace(s)));
		}
		return '';
	});

	query = query.trim();

	return {
		tags,
		extensionFilters: extensions,
		query
	};
}
