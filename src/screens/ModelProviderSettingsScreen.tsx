/**
 * 模型与供应商：BYOK 自配各供应商 API Key + 官方精选套餐订阅状态
 * 交互对齐 FlopsWeb：列表只显示已配置供应商（简洁卡片 + 配置按钮）；
 * 「添加订阅」→ 选供应商弹窗 →（新建）表单弹窗；点已配置卡片 →（管理）表单弹窗。
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
  testProviderKey,
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

  // 订阅卡片标题：catalog 的 official 项 label，或 official_subscription.tier_label
  const officialLabel = labelOf('official');
  const officialTier = official.tier_label || '';

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
            为各供应商填入你自己的 API Key 即可使用其全部模型；当前可切换模型 {availableCount} 个。
          </Text>

          {/* 订阅：由平台后台提供的精选模型（档位 股东/创始人 仅后台区分） */}
          <View style={[styles.card, { backgroundColor: colors.surface }, shadowSoftSubtle]}>
            <View style={styles.cardHeaderRow}>
              <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{officialLabel || '订阅'}</Text>
              {officialTier ? (
                <Text style={[styles.configuredTag, { color: colors.primary }]}>{officialTier}</Text>
              ) : null}
            </View>
            <Text style={[styles.cardDesc, { color: colors.textMuted }]}>
              {official.subscribed
                ? '由平台后台订阅提供，无需自配 Key。'
                : '联系管理员开通订阅后即可使用。'}
            </Text>
          </View>

          {/* BYOK：仅展示已配 key 的供应商，每个一张简洁卡片 + 配置按钮 */}
          {configuredProviders.map((pk) => {
            const st = providerKeyStatus[pk];
            return (
              <View key={pk} style={[styles.card, { backgroundColor: colors.surface }, shadowSoftSubtle]}>
                <View style={styles.cardHeaderRow}>
                  <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{labelOf(pk)}</Text>
                  <TouchableOpacity
                    style={[styles.configBtn, { borderColor: colors.border }]}
                    onPress={() => openManageProvider(pk)}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="options-outline" size={14} color={colors.textSecondary} />
                    <Text style={[styles.configBtnText, { color: colors.textSecondary }]}>配置</Text>
                  </TouchableOpacity>
                </View>
                <Text style={[styles.configuredTag, { color: colors.primary, marginTop: 8 }]}>
                  ✓ 已配置 {st?.hint || ''}
                </Text>
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
            <TextInput
              style={[
                styles.input,
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

            {testing ? (
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={[styles.statusText, { color: colors.textMuted }]}>正在测试…</Text>
              </View>
            ) : testResult ? (
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
              <TouchableOpacity
                style={[
                  styles.btn,
                  styles.btnGhost,
                  { borderColor: colors.border, opacity: testing || (!isManage && !tokenTrim) ? 0.5 : 1 },
                ]}
                disabled={testing || (!isManage && !tokenTrim)}
                onPress={() => void handleTest()}
                activeOpacity={0.8}
              >
                <Text style={[styles.btnGhostText, { color: colors.textSecondary }]}>
                  {testing ? '测试中…' : tokenTrim ? '测试' : '测试当前 Key'}
                </Text>
              </TouchableOpacity>
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
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
  input: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Menlo',
  },
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
});
