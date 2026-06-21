/**
 * 模型与供应商：BYOK 自配各供应商 API Key + 官方精选套餐订阅 + 模型白名单
 * 交互对齐 FlopsWeb / FlopsDesktop：每个供应商一张可展开卡片（手风琴）——
 *   卡头：展开箭头 + 供应商启用开关 + 标题/数量 +（BYOK）配置按钮；
 *   展开后：该供应商各模型的勾选行（模型白名单，即时落库）。
 * 「添加订阅」→ 选供应商弹窗 →（新建）填 key 弹窗；点卡头「配置」→（管理）改 key/删除弹窗。
 * 弹窗只管 API Key；白名单编辑在卡片内联，不在弹窗里。
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  Modal,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import type { RootStackParamList } from '../navigation/types';
import { useAppTheme } from '../context/ThemeContext';
import { useSession } from '../context/SessionContext';
import { shadowSoftSubtle } from '../theme/shadows';
import {
  getModelsConfig,
  setProviderKey,
  setModelAllowlist,
  setProviderAllowlist,
  testProviderKey,
  marketIdOf,
  getAllowlistProviderKeyFromModelId,
  type ModelsConfigResponse,
} from '../api';

// 可 BYOK 配置 key 的供应商（official=官方套餐 / flops=资源节点 / other 不在此列）
const BYOK_PROVIDER_KEYS = ['openrouter', 'minimax', 'dashscope', 'deepseek', 'aiprimetech', 'bailianplan'];

// 表单弹窗步骤：'' 关闭 / 'pick' 选供应商 / 'new' 新建 / 'manage' 管理
type AddProviderStep = '' | 'pick' | 'new' | 'manage';
type TestResult = { ok: boolean; message: string } | null;

export function ModelProviderSettingsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const { session } = useSession();

  const [config, setConfig] = useState<ModelsConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // 添加/管理供应商弹窗状态
  const [step, setStep] = useState<AddProviderStep>('');
  const [providerType, setProviderType] = useState('');
  const [token, setToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>(null);
  const [saving, setSaving] = useState(false);
  // 模型白名单：正在切换的 model_id（用于该行 loading + 防抖）
  const [allowlistBusy, setAllowlistBusy] = useState<string | null>(null);
  // 供应商卡片展开态（默认收起）；正在切换启用开关的供应商 key
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [providerBusy, setProviderBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      setConfig(await getModelsConfig(session));
    } catch (e) {
      Alert.alert('加载失败', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  const catalog = config?.allowlist_provider_catalog || [];
  const labelOf = (key: string) => catalog.find((c) => c && c.key === key)?.label || key;
  const providerKeyStatus = config?.provider_key_status || {};
  const official = config?.official_subscription || {};
  const availableCount = Object.keys(config?.available_models || {}).length;

  const configuredProviders = BYOK_PROVIDER_KEYS.filter((p) => !!providerKeyStatus[p]);
  const addableProviders = BYOK_PROVIDER_KEYS.filter((p) => !configuredProviders.includes(p));

  // 按供应商分组全部模型（all_models 含全部市面模型，BYOK owner=自己），用于卡片内白名单勾选。
  const allModels = config?.all_models || {};
  const allowlistIds = config?.allowlist_ids || [];
  const providerAllowKeys = config?.allowlist_provider_keys || [];
  const groups: Record<string, [string, string][]> = {};
  for (const [label, mid] of Object.entries(allModels)) {
    const pk = getAllowlistProviderKeyFromModelId(mid);
    (groups[pk] || (groups[pk] = [])).push([label, mid]);
  }
  // 卡片顺序按 catalog；只展示 订阅(official) / 资源节点(flops) / 已配 key 的 BYOK 供应商。
  const orderKeys =
    catalog.length > 0
      ? catalog.map((e) => e && e.key).filter((k): k is string => !!k)
      : Object.keys(groups).sort();
  const visibleKeys = orderKeys.filter(
    (pk) => pk === 'official' || pk === 'flops' || configuredProviders.includes(pk),
  );

  const closeModal = useCallback(() => {
    setStep('');
    setProviderType('');
    setToken('');
    setTesting(false);
    setTestResult(null);
    setSaving(false);
  }, []);

  // 第一步：打开「选供应商」弹窗
  const openAddProvider = useCallback(() => {
    setProviderType('');
    setToken('');
    setTestResult(null);
    setTesting(false);
    setSaving(false);
    setStep('pick');
  }, []);

  // 选中某供应商 → 进第二步「填 token，新建」
  const pickAddProvider = useCallback((pk: string) => {
    setProviderType(pk);
    setToken('');
    setTestResult(null);
    setStep('new');
  }, []);

  // 点已配置卡片的「配置」→ 打开管理弹窗（更换 Key / 测试 / 删除）
  const openManageProvider = useCallback((pk: string) => {
    setProviderType(pk);
    setToken('');
    setTestResult(null);
    setTesting(false);
    setSaving(false);
    setStep('manage');
  }, []);

  // 测试 key 连通性（不落库）；token 为空时后端用已存的老 key 测
  const handleTest = useCallback(async () => {
    if (!session || !providerType) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testProviderKey(session, providerType, token.trim());
      setTestResult({ ok: r.ok, message: r.message });
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }, [session, providerType, token]);

  // 创建 / 保存：写 key（成功后 setConfig + 关弹窗）
  const handleSave = useCallback(async () => {
    if (!session || !providerType) return;
    const t = token.trim();
    if (!t) return;
    setSaving(true);
    try {
      const data = await setProviderKey(session, providerType, t);
      setConfig(data);
      closeModal();
    } catch (e) {
      Alert.alert('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [session, providerType, token, closeModal]);

  // 删除订阅：清空 key（带 Alert 确认）
  const handleDelete = useCallback(() => {
    if (!session || !providerType) return;
    const label = labelOf(providerType);
    Alert.alert('删除订阅', `删除 ${label} 订阅（清除已保存的 API Key）？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setSaving(true);
            try {
              const data = await setProviderKey(session, providerType, '');
              setConfig(data);
              closeModal();
            } catch (e) {
              Alert.alert('删除失败', e instanceof Error ? e.message : String(e));
            } finally {
              setSaving(false);
            }
          })();
        },
      },
    ]);
    // labelOf 依赖 catalog（config），故依赖 config
  }, [session, providerType, closeModal, config]); // eslint-disable-line react-hooks/exhaustive-deps

  // 切换某模型是否在白名单内（即时落库；乐观更新 + 失败回滚）。
  // 白名单为全用户级（跨供应商），故每次都把更新后的完整列表发给后端；后端拒绝空列表。
  const handleToggleModel = useCallback(
    async (modelId: string) => {
      if (!session) return;
      const current = config?.allowlist_ids || [];
      const checked = current.includes(modelId);
      const next = checked ? current.filter((id) => id !== modelId) : [...current, modelId];
      if (next.length === 0) {
        Alert.alert('无法移除', '至少需要保留一个模型在白名单内。');
        return;
      }
      setAllowlistBusy(modelId);
      // 乐观更新
      setConfig((prev) => (prev ? { ...prev, allowlist_ids: next } : prev));
      try {
        const data = await setModelAllowlist(session, next);
        setConfig(data);
      } catch (e) {
        // 回滚
        setConfig((prev) => (prev ? { ...prev, allowlist_ids: current } : prev));
        Alert.alert('保存失败', e instanceof Error ? e.message : String(e));
      } finally {
        setAllowlistBusy(null);
      }
    },
    [session, config],
  );

  // 价格行：与 ChatScreen / FlopsWeb ModelPicker 一致（model_price_reference 以 market_id 为键）。
  const priceLineOf = useCallback(
    (modelId: string): string | null => {
      const ref = (config?.model_price_reference || {}) as Record<string, unknown>;
      const p = ref[marketIdOf(modelId)];
      if (p === undefined) return null;
      if (p === 0) return '免费';
      if (typeof p === 'object' && p != null) {
        const o = p as { input?: unknown; output?: unknown };
        if (typeof o.input === 'number' && typeof o.output === 'number') {
          return `入 $${o.input} · 出 $${o.output}/M`;
        }
      }
      return null;
    },
    [config],
  );

  // 切换某供应商是否启用（provider allowlist，即时落库；乐观更新 + 失败回滚）。
  // 仅当该供应商已启用，其勾选的模型才会出现在聊天页列表；后端拒绝空列表。
  const handleToggleProvider = useCallback(
    async (pk: string) => {
      if (!session) return;
      const current = config?.allowlist_provider_keys || [];
      const checked = current.includes(pk);
      const nextSet = checked ? current.filter((k) => k !== pk) : [...current, pk];
      if (nextSet.length === 0) {
        Alert.alert('无法关闭', '至少需要启用一个供应商。');
        return;
      }
      // 按 catalog 顺序归一
      const cat = config?.allowlist_provider_catalog || [];
      const order = cat.map((e) => e && e.key).filter((k): k is string => !!k);
      const ordered = order.length ? order.filter((k) => nextSet.includes(k)) : nextSet;
      setProviderBusy(pk);
      setConfig((prev) => (prev ? { ...prev, allowlist_provider_keys: ordered } : prev));
      try {
        const data = await setProviderAllowlist(session, ordered);
        setConfig(data);
      } catch (e) {
        setConfig((prev) => (prev ? { ...prev, allowlist_provider_keys: current } : prev));
        Alert.alert('保存失败', e instanceof Error ? e.message : String(e));
      } finally {
        setProviderBusy(null);
      }
    },
    [session, config],
  );

  const toggleExpand = useCallback((pk: string) => {
    setExpanded((prev) => ({ ...prev, [pk]: !prev[pk] }));
  }, []);

  const tokenTrim = token.trim();
  const isManage = step === 'manage';
  const manageStatus = isManage ? providerKeyStatus[providerType] : undefined;
  const modalLabel = labelOf(providerType);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.backgroundSecondary }]} edges={['bottom']}>
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 8,
            backgroundColor: colors.headerBarBackground,
            borderBottomWidth: colors.headerBarBottomBorderWidth,
            borderBottomColor: colors.headerBarBottomBorderColor,
          },
        ]}
      >
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textHeader }]}>模型与供应商</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <Text style={[styles.hint, { color: colors.textMuted }]}>
            订阅由平台后台提供（需管理员开通）。其余供应商点「添加订阅」填入你自己的 API Key 即可使用。
            展开供应商可勾选要在聊天页出现的模型；当前可切换模型 {availableCount} 个。
          </Text>

          {/* 每个供应商一张可展开卡片：卡头(开关/标题/配置) + 展开后内联模型白名单 */}
          {visibleKeys.map((pk) => {
            const entries = groups[pk] || [];
            if (entries.length === 0) return null;
            const isExpanded = expanded[pk] === true;
            const isByok = BYOK_PROVIDER_KEYS.includes(pk);
            const vendorChecked = providerAllowKeys.includes(pk);
            const vBusy = providerBusy === pk;
            const st = providerKeyStatus[pk];
            return (
              <View key={pk} style={[styles.card, styles.providerCard, { backgroundColor: colors.surface }, shadowSoftSubtle]}>
                <View style={styles.providerHeader}>
                  {/* 供应商启用开关（vendor toggle） */}
                  <TouchableOpacity
                    onPress={() => void handleToggleProvider(pk)}
                    disabled={vBusy}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 6 }}
                    activeOpacity={0.7}
                  >
                    {vBusy ? (
                      <ActivityIndicator size="small" color={colors.textMuted} />
                    ) : (
                      <Ionicons
                        name={vendorChecked ? 'checkbox' : 'square-outline'}
                        size={22}
                        color={vendorChecked ? colors.primary : colors.textMuted}
                      />
                    )}
                  </TouchableOpacity>
                  {/* 标题区：点击展开/收起 */}
                  <TouchableOpacity
                    style={styles.providerTitleArea}
                    onPress={() => toggleExpand(pk)}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={isExpanded ? 'chevron-down' : 'chevron-forward'}
                      size={16}
                      color={colors.textSecondary}
                    />
                    <Text style={[styles.cardTitle, styles.providerTitle, { color: colors.textPrimary }]} numberOfLines={1}>
                      {labelOf(pk)}
                    </Text>
                    <Text style={[styles.providerCount, { color: colors.textMuted }]}>{entries.length}</Text>
                  </TouchableOpacity>
                  {/* BYOK：配置 API Key 按钮 */}
                  {isByok ? (
                    <TouchableOpacity
                      style={[styles.configBtn, { borderColor: colors.border }]}
                      onPress={() => openManageProvider(pk)}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="options-outline" size={14} color={colors.textSecondary} />
                      <Text style={[styles.configBtnText, { color: colors.textSecondary }]}>配置</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>

                {/* 展开：内联模型白名单 */}
                {isExpanded ? (
                  <View style={styles.providerBody}>
                    {pk === 'official' ? (
                      <Text style={[styles.cardDesc, { color: colors.textMuted, marginBottom: 4 }]}>
                        {official.subscribed
                          ? '由平台后台订阅提供，无需自配 Key。'
                          : '联系管理员开通订阅后即可使用。'}
                      </Text>
                    ) : null}
                    {entries.map(([label, mid]) => {
                      const checked = allowlistIds.includes(mid);
                      const busy = allowlistBusy === mid;
                      const price = priceLineOf(mid);
                      return (
                        <TouchableOpacity
                          key={mid}
                          style={[styles.allowlistRow, !vendorChecked && styles.allowlistRowDim]}
                          onPress={() => void handleToggleModel(mid)}
                          disabled={busy}
                          activeOpacity={0.7}
                        >
                          <Ionicons
                            name={checked ? 'checkbox' : 'square-outline'}
                            size={20}
                            color={checked ? colors.primary : colors.textMuted}
                          />
                          <Text
                            style={[styles.allowlistRowLabel, { color: colors.textPrimary }]}
                            numberOfLines={1}
                          >
                            {label}
                          </Text>
                          {price ? (
                            <Text style={[styles.allowlistRowPrice, { color: colors.textMuted }]}>{price}</Text>
                          ) : null}
                          {busy ? (
                            <ActivityIndicator size="small" color={colors.textMuted} style={styles.allowlistRowSpin} />
                          ) : null}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            );
          })}

          {/* 添加订阅：选择一个还没加过的供应商类型 */}
          <TouchableOpacity
            style={[styles.addBtn, { borderColor: colors.border, opacity: addableProviders.length === 0 ? 0.5 : 1 }]}
            disabled={addableProviders.length === 0}
            onPress={openAddProvider}
            activeOpacity={0.8}
          >
            <Ionicons name="add" size={18} color={colors.textSecondary} />
            <Text style={[styles.addBtnText, { color: colors.textSecondary }]}>添加订阅</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* 第一步：选供应商弹窗 */}
      <Modal visible={step === 'pick'} transparent animationType="fade" onRequestClose={closeModal}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={closeModal}>
          <TouchableOpacity activeOpacity={1} style={[styles.modalCard, { backgroundColor: colors.surface }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>选择供应商</Text>
            <View style={styles.modalPicker}>
              {addableProviders.length === 0 ? (
                <Text style={[styles.cardDesc, { color: colors.textMuted }]}>已添加全部可配置供应商</Text>
              ) : (
                addableProviders.map((pk, idx) => (
                  <TouchableOpacity
                    key={pk}
                    style={[
                      styles.pickerItem,
                      idx > 0 && { borderTopWidth: 1, borderTopColor: colors.surfaceMuted },
                    ]}
                    onPress={() => pickAddProvider(pk)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.pickerItemText, { color: colors.textPrimary }]}>{labelOf(pk)}</Text>
                  </TouchableOpacity>
                ))
              )}
            </View>
            <View style={styles.modalActions}>
              <View style={styles.flexSpacer} />
              <TouchableOpacity
                style={[styles.btn, styles.btnGhost, { borderColor: colors.border }]}
                onPress={closeModal}
                activeOpacity={0.8}
              >
                <Text style={[styles.btnGhostText, { color: colors.textSecondary }]}>取消</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* 第二步 / 管理：填 token + 测试 + 创建/保存（manage 额外有删除 + 已配置状态） */}
      <Modal
        visible={step === 'new' || step === 'manage'}
        transparent
        animationType="fade"
        onRequestClose={closeModal}
      >
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={closeModal}>
          <TouchableOpacity activeOpacity={1} style={[styles.modalCard, { backgroundColor: colors.surface }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>
              {isManage ? `配置 ${modalLabel} 订阅` : `添加 ${modalLabel} 订阅`}
            </Text>
            {isManage && manageStatus ? (
              <Text style={[styles.configuredTag, { color: colors.primary, marginBottom: 8 }]}>
                ✓ 已配置 {manageStatus.hint || ''}
              </Text>
            ) : null}
            <Text style={[styles.modalLabel, { color: colors.textMuted }]}>
              {isManage ? '更换 Key（留空则不修改）' : 'API Key'}
            </Text>
            <View style={styles.inputRow}>
              <TextInput
                style={[
                  styles.input,
                  styles.inputFlex,
                  { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.surfaceMuted },
                ]}
                placeholder={isManage ? '输入新的 API Key 以替换' : `填入你的 ${modalLabel} API Key`}
                placeholderTextColor={colors.textMuted}
                value={token}
                onChangeText={(t) => {
                  setToken(t);
                  setTestResult(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
              <TouchableOpacity
                style={[
                  styles.testBtn,
                  { borderColor: colors.border, opacity: testing || (!isManage && !tokenTrim) ? 0.5 : 1 },
                ]}
                disabled={testing || (!isManage && !tokenTrim)}
                onPress={() => void handleTest()}
                activeOpacity={0.8}
              >
                {testing ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : (
                  <Text style={[styles.testBtnText, { color: colors.textSecondary }]}>
                    {tokenTrim ? '测试' : '测试'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>

            {testResult ? (
              <View style={styles.statusRow}>
                <Text style={[styles.statusText, { color: testResult.ok ? '#16a34a' : '#dc2626' }]}>
                  {testResult.ok ? '✓ 测试成功，可以使用' : `✗ ${testResult.message}`}
                </Text>
              </View>
            ) : null}

            <View style={styles.modalActions}>
              {isManage ? (
                <TouchableOpacity
                  style={[styles.btn, styles.btnGhost, { borderColor: '#dc2626', opacity: saving ? 0.5 : 1 }]}
                  disabled={saving}
                  onPress={handleDelete}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.btnGhostText, { color: '#dc2626' }]}>删除订阅</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.btn, styles.btnGhost, { borderColor: colors.border }]}
                  onPress={() => setStep('pick')}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.btnGhostText, { color: colors.textSecondary }]}>返回</Text>
                </TouchableOpacity>
              )}
              <View style={styles.flexSpacer} />
              <TouchableOpacity
                style={[styles.btn, styles.btnGhost, { borderColor: colors.border }]}
                onPress={closeModal}
                activeOpacity={0.8}
              >
                <Text style={[styles.btnGhostText, { color: colors.textSecondary }]}>
                  {isManage ? '关闭' : '取消'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: colors.primary, opacity: !tokenTrim || saving || testing ? 0.5 : 1 }]}
                disabled={!tokenTrim || saving || testing}
                onPress={() => void handleSave()}
                activeOpacity={0.8}
              >
                <Text style={styles.btnPrimaryText}>{saving ? '保存中…' : isManage ? '保存' : '创建'}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 12 },
  backBtn: { padding: 8, width: 40 },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700' },
  headerSpacer: { width: 40 },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 40 },
  hint: { fontSize: 14, lineHeight: 20, marginBottom: 16 },
  card: { borderRadius: 12, padding: 16, marginBottom: 14 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  cardDesc: { fontSize: 13, lineHeight: 19, marginTop: 6 },
  configuredTag: { fontSize: 12, fontWeight: '500' },
  configBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  configBtnText: { fontSize: 13, fontWeight: '500' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Menlo',
  },
  inputFlex: { flex: 1 },
  testBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  testBtnText: { fontSize: 14, fontWeight: '500' },
  btn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  btnPrimaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1 },
  btnGhostText: { fontSize: 14, fontWeight: '500' },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  addBtnText: { fontSize: 14, fontWeight: '500' },
  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: { width: '100%', maxWidth: 440, borderRadius: 14, padding: 20 },
  modalTitle: { fontSize: 17, fontWeight: '700', marginBottom: 12 },
  modalLabel: { fontSize: 13, fontWeight: '500', marginTop: 4 },
  modalPicker: { marginBottom: 8 },
  pickerItem: { paddingVertical: 14, paddingHorizontal: 4 },
  pickerItemText: { fontSize: 15 },
  modalActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap' },
  flexSpacer: { flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  statusText: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
  // 供应商可展开卡片（手风琴）
  providerCard: { paddingVertical: 12 },
  providerHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  providerTitleArea: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  providerTitle: { flexShrink: 1 },
  providerCount: { fontSize: 12, fontWeight: '500' },
  providerBody: { marginTop: 8 },
  // 内联模型白名单勾选行
  allowlistRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  allowlistRowDim: { opacity: 0.45 },
  allowlistRowLabel: { flex: 1, fontSize: 14 },
  allowlistRowPrice: { fontSize: 11, fontFamily: 'Menlo' },
  allowlistRowSpin: { marginLeft: 2 },
});
