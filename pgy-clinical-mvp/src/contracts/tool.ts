/** Tool 描述符：执行确定动作，不拥有临床主权。 */
export interface RuntimeToolDescriptor {
  id: string;
  description: string;
  risk?: 'low' | 'medium' | 'high';
  /** H14：该工具是否直接面向治疗知识（formula / treatment-form）。Core 不做业务判断。 */
  treatmentSpecific?: boolean;
  /**
   * Control Plane V2：工具能产生的 execution effects。
   * Action surface 以后按 effect ∩ runnable obligation 投影，而不是按 tool id switch。
   */
  effects?: string[];
  /**
   * Control Plane V2.1: structural effect patterns. Kept optional during shadow migration.
   * Runtime projects tools by pattern matching against runnable parameterized effects.
   */
  effectPatternsV21?: Array<{
    op: 'retrieve' | 'commit' | 'validate' | 'inspect';
    target?: {
      type: string;
      qualifiers?: Record<string, string | number | boolean>;
      producerCapabilityId?: string;
      producerRuleId?: string;
    };
    params?: Record<string, string | number | boolean>;
  }>;
}
